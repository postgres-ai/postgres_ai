import pkg from "../package.json";
import * as config from "./config";
import { fetchIssues, fetchIssueComments, createIssueComment, fetchIssue, createIssue, updateIssue, updateIssueComment } from "./issues";
import { resolveBaseUrls } from "./util";
import * as childProcess from "child_process";
import * as fs from "fs";
import * as path from "path";

// MCP SDK imports - Bun handles these directly
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// AI DBA Helper: Execute shell command and return output
async function execCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    childProcess.execFile(command, args, { encoding: "utf8", timeout: 120000 }, (error, stdout, stderr) => {
      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
  });
}

// AI DBA Helper: Fetch metrics from Flask backend
async function fetchGrafanaMetrics(params: {
  timeStart?: string;
  timeEnd?: string;
  clusterName?: string;
  nodeName?: string;
  dbName?: string;
}): Promise<{ data: string; error?: string }> {
  const baseUrl = process.env.PGAI_FLASK_URL || "http://localhost:55000";
  const url = new URL(`${baseUrl}/pgss_metrics/csv`);

  if (params.timeStart) url.searchParams.set("time_start", params.timeStart);
  if (params.timeEnd) url.searchParams.set("time_end", params.timeEnd);
  if (params.clusterName) url.searchParams.set("cluster_name", params.clusterName);
  if (params.nodeName) url.searchParams.set("node_name", params.nodeName);
  if (params.dbName) url.searchParams.set("db_name", params.dbName);

  try {
    const response = await fetch(url.toString(), { method: "GET" });
    if (response.ok) {
      return { data: await response.text() };
    }
    return { data: "", error: `HTTP ${response.status}: ${await response.text()}` };
  } catch (err) {
    return { data: "", error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RootOptsLike {
  apiKey?: string;
  apiBaseUrl?: string;
}

// Interpret escape sequences (e.g., \n -> newline). Input comes from JSON, but
// we still normalize common escapes for consistency.
export const interpretEscapes = (str: string): string =>
  (str || "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");

export interface McpToolRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

export interface McpToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** Handle MCP tool calls - exported for testing */
export async function handleToolCall(
  req: McpToolRequest,
  rootOpts?: RootOptsLike,
  extra?: { debug?: boolean }
): Promise<McpToolResponse> {
  const toolName = req.params.name;
  const args = (req.params.arguments as Record<string, unknown>) || {};

  const cfg = config.readConfig();
  const apiKey = (rootOpts?.apiKey || process.env.PGAI_API_KEY || cfg.apiKey || "").toString();
  const { apiBaseUrl } = resolveBaseUrls(rootOpts, cfg);

  const debug = Boolean(args.debug ?? extra?.debug);

  if (!apiKey) {
    return {
      content: [
        {
          type: "text",
          text: "API key is required. Run 'pgai auth' or set PGAI_API_KEY.",
        },
      ],
      isError: true,
    };
  }

  try {
    if (toolName === "list_issues") {
      const issues = await fetchIssues({ apiKey, apiBaseUrl, debug });
      return { content: [{ type: "text", text: JSON.stringify(issues, null, 2) }] };
    }

    if (toolName === "view_issue") {
      const issueId = String(args.issue_id || "").trim();
      if (!issueId) {
        return { content: [{ type: "text", text: "issue_id is required" }], isError: true };
      }
      const issue = await fetchIssue({ apiKey, apiBaseUrl, issueId, debug });
      if (!issue) {
        return { content: [{ type: "text", text: "Issue not found" }], isError: true };
      }
      const comments = await fetchIssueComments({ apiKey, apiBaseUrl, issueId, debug });
      const combined = { issue, comments };
      return { content: [{ type: "text", text: JSON.stringify(combined, null, 2) }] };
    }

    if (toolName === "post_issue_comment") {
      const issueId = String(args.issue_id || "").trim();
      const rawContent = String(args.content || "");
      const parentCommentId = args.parent_comment_id ? String(args.parent_comment_id) : undefined;
      if (!issueId) {
        return { content: [{ type: "text", text: "issue_id is required" }], isError: true };
      }
      if (!rawContent) {
        return { content: [{ type: "text", text: "content is required" }], isError: true };
      }
      const content = interpretEscapes(rawContent);
      const result = await createIssueComment({ apiKey, apiBaseUrl, issueId, content, parentCommentId, debug });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (toolName === "create_issue") {
      const rawTitle = String(args.title || "").trim();
      if (!rawTitle) {
        return { content: [{ type: "text", text: "title is required" }], isError: true };
      }
      const title = interpretEscapes(rawTitle);
      const rawDescription = args.description ? String(args.description) : undefined;
      const description = rawDescription ? interpretEscapes(rawDescription) : undefined;
      const projectId = args.project_id !== undefined ? Number(args.project_id) : undefined;
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : undefined;
      // Get orgId from args or fall back to config
      const orgId = args.org_id !== undefined ? Number(args.org_id) : cfg.orgId;
      // Note: orgId=0 is technically valid (though unlikely), so don't use falsy check
      if (orgId === undefined || orgId === null || Number.isNaN(orgId)) {
        return { content: [{ type: "text", text: "org_id is required. Either provide it as a parameter or run 'pgai auth' to set it in config." }], isError: true };
      }
      const result = await createIssue({ apiKey, apiBaseUrl, title, orgId, description, projectId, labels, debug });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (toolName === "update_issue") {
      const issueId = String(args.issue_id || "").trim();
      if (!issueId) {
        return { content: [{ type: "text", text: "issue_id is required" }], isError: true };
      }
      const rawTitle = args.title !== undefined ? String(args.title) : undefined;
      const title = rawTitle !== undefined ? interpretEscapes(rawTitle) : undefined;
      const rawDescription = args.description !== undefined ? String(args.description) : undefined;
      const description = rawDescription !== undefined ? interpretEscapes(rawDescription) : undefined;
      const status = args.status !== undefined ? Number(args.status) : undefined;
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : undefined;
      // Validate that at least one update field is provided
      if (title === undefined && description === undefined && status === undefined && labels === undefined) {
        return { content: [{ type: "text", text: "At least one field to update is required (title, description, status, or labels)" }], isError: true };
      }
      // Validate status value if provided (check for NaN and valid values)
      if (status !== undefined && (Number.isNaN(status) || (status !== 0 && status !== 1))) {
        return { content: [{ type: "text", text: "status must be 0 (open) or 1 (closed)" }], isError: true };
      }
      const result = await updateIssue({ apiKey, apiBaseUrl, issueId, title, description, status, labels, debug });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (toolName === "update_issue_comment") {
      const commentId = String(args.comment_id || "").trim();
      const rawContent = String(args.content || "");
      if (!commentId) {
        return { content: [{ type: "text", text: "comment_id is required" }], isError: true };
      }
      if (!rawContent.trim()) {
        return { content: [{ type: "text", text: "content is required" }], isError: true };
      }
      const content = interpretEscapes(rawContent);
      const result = await updateIssueComment({ apiKey, apiBaseUrl, commentId, content, debug });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    // ==========================================
    // AI DBA Tools
    // ==========================================

    if (toolName === "dba_health_check") {
      const connectionString = String(args.connection_string || "").trim();
      const checkIds = args.check_ids ? String(args.check_ids) : undefined;
      const outputDir = args.output_dir ? String(args.output_dir) : "/tmp/ai-dba-checkup";

      // Build command arguments
      const cmdArgs = ["checkup"];
      if (connectionString) {
        cmdArgs.push(connectionString);
      }
      if (checkIds) {
        cmdArgs.push("--check-id", checkIds);
      }
      cmdArgs.push("--output", outputDir);
      cmdArgs.push("--json");

      const result = await execCommand("postgresai", cmdArgs);

      // Try to read and parse the output files
      let reports: Record<string, unknown> = {};
      try {
        if (fs.existsSync(outputDir)) {
          const files = fs.readdirSync(outputDir).filter(f => f.endsWith(".json"));
          for (const file of files) {
            const content = fs.readFileSync(path.join(outputDir, file), "utf8");
            const checkId = file.replace(".json", "");
            try {
              reports[checkId] = JSON.parse(content);
            } catch {
              reports[checkId] = { raw: content };
            }
          }
        }
      } catch (readErr) {
        // Ignore read errors, include them in output
      }

      const output = {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        reports,
        outputDir,
      };

      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    }

    if (toolName === "dba_monitoring_status") {
      const result = await execCommand("postgresai", ["mon", "status"]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            exitCode: result.exitCode,
            status: result.exitCode === 0 ? "running" : "not_running",
            stdout: result.stdout,
            stderr: result.stderr,
          }, null, 2),
        }],
      };
    }

    if (toolName === "dba_monitoring_health") {
      const waitSeconds = args.wait_seconds ? Number(args.wait_seconds) : 5;
      const result = await execCommand("postgresai", ["mon", "health", "--wait", String(waitSeconds)]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            exitCode: result.exitCode,
            healthy: result.exitCode === 0,
            stdout: result.stdout,
            stderr: result.stderr,
          }, null, 2),
        }],
      };
    }

    if (toolName === "dba_list_targets") {
      const result = await execCommand("postgresai", ["mon", "targets", "list"]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }, null, 2),
        }],
      };
    }

    if (toolName === "dba_query_metrics") {
      const timeStart = args.time_start ? String(args.time_start) : undefined;
      const timeEnd = args.time_end ? String(args.time_end) : undefined;
      const clusterName = args.cluster_name ? String(args.cluster_name) : undefined;
      const nodeName = args.node_name ? String(args.node_name) : undefined;
      const dbName = args.db_name ? String(args.db_name) : undefined;

      const result = await fetchGrafanaMetrics({ timeStart, timeEnd, clusterName, nodeName, dbName });

      if (result.error) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }],
          isError: true,
        };
      }

      // Parse CSV to JSON for easier consumption
      const lines = result.data.trim().split("\n");
      const headers = lines[0]?.split(",") || [];
      const rows = lines.slice(1).map(line => {
        const values = line.split(",");
        const row: Record<string, string> = {};
        headers.forEach((h, i) => {
          row[h] = values[i] || "";
        });
        return row;
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ headers, rows, rowCount: rows.length }, null, 2),
        }],
      };
    }

    if (toolName === "dba_analyze_findings") {
      // This tool helps structure health check findings for decision making
      const findings = args.findings ? String(args.findings) : "";
      const mode = args.mode ? String(args.mode) : "observe";

      let parsedFindings: unknown;
      try {
        parsedFindings = JSON.parse(findings);
      } catch {
        parsedFindings = findings;
      }

      // Categorize findings by severity
      const analysis = {
        mode,
        summary: {
          critical: [] as string[],
          high: [] as string[],
          medium: [] as string[],
          low: [] as string[],
        },
        recommendations: [] as string[],
        autoFixable: [] as string[],
        requiresApproval: [] as string[],
        parsedFindings,
      };

      // Add generic recommendations based on mode
      if (mode === "observe") {
        analysis.recommendations.push("Review findings and escalate critical issues to user");
        analysis.recommendations.push("Create issues for HIGH severity findings");
      } else if (mode === "advise") {
        analysis.recommendations.push("Propose remediation plan for each finding");
        analysis.recommendations.push("Wait for user approval before any action");
      } else if (mode === "auto-fix") {
        analysis.recommendations.push("Execute pre-approved safe remediations");
        analysis.recommendations.push("Log all actions to issues for audit trail");
      }

      return {
        content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }],
      };
    }

    throw new Error(`Unknown tool: ${toolName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

export async function startMcpServer(rootOpts?: RootOptsLike, extra?: { debug?: boolean }): Promise<void> {
  const server = new Server(
    { name: "postgresai-mcp", version: pkg.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "list_issues",
          description: "List issues from PostgresAI API (same as CLI 'issues list')",
          inputSchema: {
            type: "object",
            properties: {
              debug: { type: "boolean", description: "Enable verbose debug logs" },
            },
            additionalProperties: false,
          },
        },
        {
          name: "view_issue",
          description: "View a specific issue with its comments",
          inputSchema: {
            type: "object",
            properties: {
              issue_id: { type: "string", description: "Issue ID (UUID)" },
              debug: { type: "boolean", description: "Enable verbose debug logs" },
            },
            required: ["issue_id"],
            additionalProperties: false,
          },
        },
        {
          name: "post_issue_comment",
          description: "Post a new comment to an issue (optionally as a reply)",
          inputSchema: {
            type: "object",
            properties: {
              issue_id: { type: "string", description: "Issue ID (UUID)" },
              content: { type: "string", description: "Comment text (supports \\n as newline)" },
              parent_comment_id: { type: "string", description: "Parent comment ID (UUID) for replies" },
              debug: { type: "boolean", description: "Enable verbose debug logs" },
            },
            required: ["issue_id", "content"],
            additionalProperties: false,
          },
        },
        {
          name: "create_issue",
          description: "Create a new issue in PostgresAI",
          inputSchema: {
            type: "object",
            properties: {
              title: { type: "string", description: "Issue title (required)" },
              description: { type: "string", description: "Issue description (supports \\n as newline)" },
              org_id: { type: "number", description: "Organization ID (uses config value if not provided)" },
              project_id: { type: "number", description: "Project ID to associate the issue with" },
              labels: {
                type: "array",
                items: { type: "string" },
                description: "Labels to apply to the issue",
              },
              debug: { type: "boolean", description: "Enable verbose debug logs" },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        {
          name: "update_issue",
          description: "Update an existing issue (title, description, status, labels). Use status=1 to close, status=0 to reopen.",
          inputSchema: {
            type: "object",
            properties: {
              issue_id: { type: "string", description: "Issue ID (UUID)" },
              title: { type: "string", description: "New title (supports \\n as newline)" },
              description: { type: "string", description: "New description (supports \\n as newline)" },
              status: { type: "number", description: "Status: 0=open, 1=closed" },
              labels: {
                type: "array",
                items: { type: "string" },
                description: "Labels to set on the issue",
              },
              debug: { type: "boolean", description: "Enable verbose debug logs" },
            },
            required: ["issue_id"],
            additionalProperties: false,
          },
        },
        {
          name: "update_issue_comment",
          description: "Update an existing issue comment",
          inputSchema: {
            type: "object",
            properties: {
              comment_id: { type: "string", description: "Comment ID (UUID)" },
              content: { type: "string", description: "New comment text (supports \\n as newline)" },
              debug: { type: "boolean", description: "Enable verbose debug logs" },
            },
            required: ["comment_id", "content"],
            additionalProperties: false,
          },
        },
        // AI DBA Tools
        {
          name: "dba_health_check",
          description: "Run PostgreSQL health check using postgresai checkup. Returns detailed health reports for various check categories (indexes, bloat, queries, etc.)",
          inputSchema: {
            type: "object",
            properties: {
              connection_string: { type: "string", description: "PostgreSQL connection string (optional if using local monitoring)" },
              check_ids: { type: "string", description: "Comma-separated check IDs to run (e.g., 'H001,H002,F001'). Omit for all checks." },
              output_dir: { type: "string", description: "Directory to store report files (default: /tmp/ai-dba-checkup)" },
            },
            additionalProperties: false,
          },
        },
        {
          name: "dba_monitoring_status",
          description: "Check if the PostgresAI monitoring stack (Grafana, Prometheus, PGWatch) is running",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: "dba_monitoring_health",
          description: "Verify health of all monitoring services with optional wait for startup",
          inputSchema: {
            type: "object",
            properties: {
              wait_seconds: { type: "number", description: "Seconds to wait for services to become healthy (default: 5)" },
            },
            additionalProperties: false,
          },
        },
        {
          name: "dba_list_targets",
          description: "List all PostgreSQL databases currently being monitored",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: "dba_query_metrics",
          description: "Query pg_stat_statements metrics from Grafana/Flask backend for performance analysis",
          inputSchema: {
            type: "object",
            properties: {
              time_start: { type: "string", description: "Start time in ISO format (e.g., 2024-01-15T14:00:00Z)" },
              time_end: { type: "string", description: "End time in ISO format" },
              cluster_name: { type: "string", description: "Filter by cluster name" },
              node_name: { type: "string", description: "Filter by node name" },
              db_name: { type: "string", description: "Filter by database name" },
            },
            additionalProperties: false,
          },
        },
        {
          name: "dba_analyze_findings",
          description: "Analyze health check findings and categorize by severity. Helps AI DBA decide on actions based on operating mode.",
          inputSchema: {
            type: "object",
            properties: {
              findings: { type: "string", description: "JSON string of health check findings to analyze" },
              mode: { type: "string", description: "Operating mode: 'observe' (report only), 'advise' (propose fixes), 'auto-fix' (execute safe fixes)" },
            },
            required: ["findings"],
            additionalProperties: false,
          },
        },
      ],
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    return handleToolCall(req, rootOpts, extra);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
