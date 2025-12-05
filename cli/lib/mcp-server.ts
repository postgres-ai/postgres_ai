import * as pkg from "../package.json";
import * as config from "./config";
import { fetchIssues, fetchIssueComments, createIssueComment, fetchIssue } from "./issues";
import { resolveBaseUrls } from "./util";

// MCP SDK imports
import { Server } from "@modelcontextprotocol/sdk/server";
import * as path from "path";
// Types schemas will be loaded dynamically from the SDK's CJS bundle

interface RootOptsLike {
  apiKey?: string;
  apiBaseUrl?: string;
}

export async function startMcpServer(rootOpts?: RootOptsLike, extra?: { debug?: boolean }): Promise<void> {
  // Resolve stdio transport at runtime to avoid subpath export resolution issues
  const serverEntry = require.resolve("@modelcontextprotocol/sdk/server");
  const stdioPath = path.join(path.dirname(serverEntry), "stdio.js");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { StdioServerTransport } = require(stdioPath);
  // Load schemas dynamically to avoid subpath export resolution issues
  const typesPath = path.resolve(path.dirname(serverEntry), "../types.js");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CallToolRequestSchema, ListToolsRequestSchema } = require(typesPath);

  const server = new Server(
    { name: "postgresai-mcp", version: pkg.version },
    { capabilities: { tools: {} } }
  );

  // Interpret escape sequences (e.g., \n -> newline). Input comes from JSON, but
  // we still normalize common escapes for consistency.
  const interpretEscapes = (str: string): string =>
    (str || "")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");

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
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
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

      throw new Error(`Unknown tool: ${toolName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}


