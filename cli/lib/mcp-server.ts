import * as pkg from "../package.json";
import * as config from "./config";
import { fetchIssues } from "./issues";
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
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const toolName = req.params.name;
    const args = (req.params.arguments as Record<string, unknown>) || {};

    if (toolName !== "list_issues") {
      throw new Error(`Unknown tool: ${toolName}`);
    }

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
      const result = await fetchIssues({ apiKey, apiBaseUrl, debug });
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: message },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}


