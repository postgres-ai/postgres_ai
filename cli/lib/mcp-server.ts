import pkg from "../package.json";
import * as config from "./config";
import { fetchIssues, fetchIssueComments, createIssueComment, fetchIssue, createIssue, updateIssue, updateIssueComment } from "./issues";
import { resolveBaseUrls } from "./util";

// MCP SDK imports - Bun handles these directly
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
