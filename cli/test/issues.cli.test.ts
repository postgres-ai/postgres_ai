import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

function runCli(args: string[], env: Record<string, string> = {}) {
  const cliPath = resolve(import.meta.dir, "..", "bin", "postgres-ai.ts");
  const bunBin = typeof process.execPath === "string" && process.execPath.length > 0 ? process.execPath : "bun";
  const result = Bun.spawnSync([bunBin, cliPath, ...args], {
    env: { ...process.env, ...env },
  });
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function runCliAsync(args: string[], env: Record<string, string> = {}) {
  const cliPath = resolve(import.meta.dir, "..", "bin", "postgres-ai.ts");
  const bunBin = typeof process.execPath === "string" && process.execPath.length > 0 ? process.execPath : "bun";
  const proc = Bun.spawn([bunBin, cliPath, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

function isolatedEnv(extra: Record<string, string> = {}) {
  // Ensure tests do not depend on any real user config on the machine running them.
  const cfgHome = mkdtempSync(resolve(tmpdir(), "postgresai-cli-test-"));
  return {
    XDG_CONFIG_HOME: cfgHome,
    HOME: cfgHome,
    ...extra,
  };
}

async function startFakeApi() {
  const requests: Array<{
    method: string;
    pathname: string;
    headers: Record<string, string>;
    bodyText: string;
    bodyJson: any | null;
  }> = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers.entries()) headers[k.toLowerCase()] = v;

      const bodyText = await req.text();
      let bodyJson: any | null = null;
      try {
        bodyJson = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        bodyJson = null;
      }

      requests.push({
        method: req.method,
        pathname: url.pathname,
        headers,
        bodyText,
        bodyJson,
      });

      // Minimal fake PostgREST RPC endpoints used by our CLI.
      if (req.method === "POST" && url.pathname.endsWith("/rpc/issue_create")) {
        return new Response(
          JSON.stringify({
            id: "issue-1",
            title: bodyJson?.title ?? "",
            description: bodyJson?.description ?? null,
            created_at: "2025-01-01T00:00:00Z",
            status: 0,
            project_id: bodyJson?.project_id ?? null,
            labels: bodyJson?.labels ?? null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (req.method === "POST" && url.pathname.endsWith("/rpc/issue_update")) {
        return new Response(
          JSON.stringify({
            id: bodyJson?.p_id ?? "issue-1",
            title: bodyJson?.p_title ?? "unchanged",
            description: bodyJson?.p_description ?? null,
            status: bodyJson?.p_status ?? 0,
            updated_at: "2025-01-02T00:00:00Z",
            labels: bodyJson?.p_labels ?? null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (req.method === "POST" && url.pathname.endsWith("/rpc/issue_comment_update")) {
        return new Response(
          JSON.stringify({
            id: bodyJson?.p_id ?? "comment-1",
            issue_id: "issue-1",
            content: bodyJson?.p_content ?? "",
            updated_at: "2025-01-02T00:00:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (req.method === "POST" && url.pathname.endsWith("/rpc/issue_comment_create")) {
        return new Response(
          JSON.stringify({
            id: "comment-1",
            issue_id: bodyJson?.issue_id ?? "issue-1",
            author_id: 1,
            parent_comment_id: bodyJson?.parent_comment_id ?? null,
            content: bodyJson?.content ?? "",
            created_at: "2025-01-01T00:00:00Z",
            updated_at: "2025-01-01T00:00:00Z",
            data: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Action Items endpoints
      if (req.method === "GET" && url.pathname.endsWith("/issue_action_items")) {
        const issueIdParam = url.searchParams.get("issue_id");
        const idParam = url.searchParams.get("id");
        if (issueIdParam) {
          // list_action_items
          return new Response(
            JSON.stringify([
              { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", issue_id: issueIdParam.replace("eq.", ""), title: "Action 1", is_done: false, status: "waiting_for_approval" },
              { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", issue_id: issueIdParam.replace("eq.", ""), title: "Action 2", is_done: true, status: "approved" },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (idParam) {
          // view_action_item
          const actionId = idParam.replace("eq.", "").replace("in.(", "").replace(")", "").split(",")[0];
          return new Response(
            JSON.stringify([
              { id: actionId, issue_id: "11111111-1111-1111-1111-111111111111", title: "Test Action", description: "Test description", is_done: false, status: "waiting_for_approval", sql_action: "SELECT 1;", configs: [] },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      if (req.method === "POST" && url.pathname.endsWith("/rpc/issue_action_item_create")) {
        return new Response(
          JSON.stringify("cccccccc-cccc-cccc-cccc-cccccccccccc"),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (req.method === "POST" && url.pathname.endsWith("/rpc/issue_action_item_update")) {
        return new Response("", { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const baseUrl = `http://${server.hostname}:${server.port}/api/general`;

  return {
    baseUrl,
    requests,
    stop: () => server.stop(true),
  };
}

describe("CLI issues command group", () => {
  test("issues help exposes the canonical subcommands and no legacy names", () => {
    const r = runCli(["issues", "--help"], isolatedEnv());
    expect(r.status).toBe(0);

    const out = `${r.stdout}\n${r.stderr}`;

    // Canonical subcommands
    expect(out).toContain("create [options] <title>");
    expect(out).toContain("update [options] <issueId>");
    expect(out).toContain("update-comment [options] <commentId> <content>");
    expect(out).toContain("post-comment [options] <issueId> <content>");

    // Legacy / removed names
    expect(out).not.toContain("create-issue");
    expect(out).not.toContain("update-issue");
    expect(out).not.toContain("update-issue-comment");
    expect(out).not.toContain("post_comment");
    expect(out).not.toContain("create_issue");
    expect(out).not.toContain("update_issue");
    expect(out).not.toContain("update_issue_comment");
  });

  test("issues create fails fast when API key is missing", () => {
    const r = runCli(["issues", "create", "Test issue"], isolatedEnv());
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("API key is required");
  });

  test("issues create fails fast when org id is missing (no config fallback)", () => {
    const r = runCli(["issues", "create", "Test issue"], isolatedEnv({ PGAI_API_KEY: "test-key" }));
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("org_id is required");
  });

  test("issues update fails fast when API key is missing", () => {
    const r = runCli(["issues", "update", "00000000-0000-0000-0000-000000000000", "--title", "New title"], isolatedEnv());
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("API key is required");
  });

  test("issues update-comment fails fast when API key is missing", () => {
    const r = runCli(["issues", "update-comment", "00000000-0000-0000-0000-000000000000", "hello"], isolatedEnv());
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("API key is required");
  });

  test("issues post-comment fails fast when API key is missing", () => {
    const r = runCli(["issues", "post-comment", "00000000-0000-0000-0000-000000000000", "hello"], isolatedEnv());
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("API key is required");
  });

  test("issues create succeeds against a fake API and sends the expected request", async () => {
    const api = await startFakeApi();
    try {
      const r = await runCliAsync(
        ["issues", "create", "Hello", "--org-id", "123", "--description", "line1\\nline2", "--label", "a", "--label", "b"],
        isolatedEnv({
          PGAI_API_KEY: "test-key",
          PGAI_API_BASE_URL: api.baseUrl,
        })
      );
      expect(r.status).toBe(0);

      const out = JSON.parse(r.stdout.trim());
      expect(out.id).toBe("issue-1");
      expect(out.title).toBe("Hello");
      expect(out.description).toBe("line1\nline2");
      expect(out.labels).toEqual(["a", "b"]);

      const req = api.requests.find((x) => x.pathname.endsWith("/rpc/issue_create"));
      expect(req).toBeTruthy();
      expect(req!.headers["access-token"]).toBe("test-key");
      expect(req!.method).toBe("POST");
      expect(req!.bodyJson.org_id).toBe(123);
      expect(req!.bodyJson.title).toBe("Hello");
      expect(req!.bodyJson.description).toBe("line1\nline2");
      expect(req!.bodyJson.labels).toEqual(["a", "b"]);
    } finally {
      api.stop();
    }
  });

  test("issues update succeeds against a fake API (including status mapping)", async () => {
    const api = await startFakeApi();
    try {
      const r = await runCliAsync(
        ["issues", "update", "issue-1", "--title", "New title", "--status", "closed"],
        isolatedEnv({
          PGAI_API_KEY: "test-key",
          PGAI_API_BASE_URL: api.baseUrl,
        })
      );
      expect(r.status).toBe(0);

      const out = JSON.parse(r.stdout.trim());
      expect(out.id).toBe("issue-1");
      expect(out.title).toBe("New title");
      expect(out.status).toBe(1);

      const req = api.requests.find((x) => x.pathname.endsWith("/rpc/issue_update"));
      expect(req).toBeTruthy();
      expect(req!.headers["access-token"]).toBe("test-key");
      expect(req!.bodyJson.p_id).toBe("issue-1");
      expect(req!.bodyJson.p_title).toBe("New title");
      expect(req!.bodyJson.p_status).toBe(1);
    } finally {
      api.stop();
    }
  });

  test("issues update-comment succeeds against a fake API and decodes escapes", async () => {
    const api = await startFakeApi();
    try {
      const r = await runCliAsync(
        ["issues", "update-comment", "comment-1", "hello\\nworld"],
        isolatedEnv({
          PGAI_API_KEY: "test-key",
          PGAI_API_BASE_URL: api.baseUrl,
        })
      );
      expect(r.status).toBe(0);

      const out = JSON.parse(r.stdout.trim());
      expect(out.id).toBe("comment-1");
      expect(out.content).toBe("hello\nworld");

      const req = api.requests.find((x) => x.pathname.endsWith("/rpc/issue_comment_update"));
      expect(req).toBeTruthy();
      expect(req!.headers["access-token"]).toBe("test-key");
      expect(req!.bodyJson.p_id).toBe("comment-1");
      expect(req!.bodyJson.p_content).toBe("hello\nworld");
    } finally {
      api.stop();
    }
  });

  test("issues post-comment succeeds against a fake API and decodes escapes", async () => {
    const api = await startFakeApi();
    try {
      const r = await runCliAsync(
        ["issues", "post-comment", "issue-1", "hello\\nworld"],
        isolatedEnv({
          PGAI_API_KEY: "test-key",
          PGAI_API_BASE_URL: api.baseUrl,
        })
      );
      expect(r.status).toBe(0);

      const out = JSON.parse(r.stdout.trim());
      expect(out.id).toBe("comment-1");
      expect(out.issue_id).toBe("issue-1");
      expect(out.content).toBe("hello\nworld");

      const req = api.requests.find((x) => x.pathname.endsWith("/rpc/issue_comment_create"));
      expect(req).toBeTruthy();
      expect(req!.headers["access-token"]).toBe("test-key");
      expect(req!.bodyJson.issue_id).toBe("issue-1");
      expect(req!.bodyJson.content).toBe("hello\nworld");
    } finally {
      api.stop();
    }
  });
});

describe("CLI action items commands", () => {
  test("issues action-items fails fast when API key is missing", () => {
    const r = runCli(["issues", "action-items", "00000000-0000-0000-0000-000000000000"], isolatedEnv());
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("API key is required");
  });

  test("issues action-items fails when issue_id is not a valid UUID", () => {
    const r = runCli(["issues", "action-items", "invalid-id"], isolatedEnv({ PGAI_API_KEY: "test-key" }));
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("issueId must be a valid UUID");
  });

  test("issues action-items succeeds against a fake API", async () => {
    const api = await startFakeApi();
    try {
      const r = await runCliAsync(
        ["issues", "action-items", "11111111-1111-1111-1111-111111111111"],
        isolatedEnv({
          PGAI_API_KEY: "test-key",
          PGAI_API_BASE_URL: api.baseUrl,
        })
      );
      expect(r.status).toBe(0);

      const out = JSON.parse(r.stdout.trim());
      expect(Array.isArray(out)).toBe(true);
      expect(out.length).toBe(2);
      expect(out[0].title).toBe("Action 1");
    } finally {
      api.stop();
    }
  });

  test("issues view-action-item fails fast when API key is missing", () => {
    const r = runCli(["issues", "view-action-item", "00000000-0000-0000-0000-000000000000"], isolatedEnv());
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("API key is required");
  });

  test("issues view-action-item fails when action_item_id is not a valid UUID", () => {
    const r = runCli(["issues", "view-action-item", "invalid-id"], isolatedEnv({ PGAI_API_KEY: "test-key" }));
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("actionItemId is required and must be a valid UUID");
  });

  test("issues view-action-item succeeds against a fake API", async () => {
    const api = await startFakeApi();
    try {
      const r = await runCliAsync(
        ["issues", "view-action-item", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
        isolatedEnv({
          PGAI_API_KEY: "test-key",
          PGAI_API_BASE_URL: api.baseUrl,
        })
      );
      expect(r.status).toBe(0);

      const out = JSON.parse(r.stdout.trim());
      expect(out[0].title).toBe("Test Action");
      expect(out[0].sql_action).toBe("SELECT 1;");
    } finally {
      api.stop();
    }
  });

  test("issues create-action-item fails fast when API key is missing", () => {
    const r = runCli(["issues", "create-action-item", "00000000-0000-0000-0000-000000000000", "Test title"], isolatedEnv());
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("API key is required");
  });

  test("issues create-action-item fails when issue_id is not a valid UUID", () => {
    const r = runCli(["issues", "create-action-item", "invalid-id", "Test title"], isolatedEnv({ PGAI_API_KEY: "test-key" }));
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("issueId must be a valid UUID");
  });

  test("issues create-action-item succeeds against a fake API", async () => {
    const api = await startFakeApi();
    try {
      const r = await runCliAsync(
        ["issues", "create-action-item", "11111111-1111-1111-1111-111111111111", "New action item", "--description", "Test description"],
        isolatedEnv({
          PGAI_API_KEY: "test-key",
          PGAI_API_BASE_URL: api.baseUrl,
        })
      );
      expect(r.status).toBe(0);

      const out = JSON.parse(r.stdout.trim());
      expect(out.id).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");

      const req = api.requests.find((x) => x.pathname.endsWith("/rpc/issue_action_item_create"));
      expect(req).toBeTruthy();
      expect(req!.headers["access-token"]).toBe("test-key");
      expect(req!.bodyJson.issue_id).toBe("11111111-1111-1111-1111-111111111111");
      expect(req!.bodyJson.title).toBe("New action item");
      expect(req!.bodyJson.description).toBe("Test description");
    } finally {
      api.stop();
    }
  });

  test("issues create-action-item interprets escape sequences", async () => {
    const api = await startFakeApi();
    try {
      const r = await runCliAsync(
        ["issues", "create-action-item", "11111111-1111-1111-1111-111111111111", "Title\\nwith newline", "--description", "Desc\\twith tab"],
        isolatedEnv({
          PGAI_API_KEY: "test-key",
          PGAI_API_BASE_URL: api.baseUrl,
        })
      );
      expect(r.status).toBe(0);

      const req = api.requests.find((x) => x.pathname.endsWith("/rpc/issue_action_item_create"));
      expect(req).toBeTruthy();
      expect(req!.bodyJson.title).toBe("Title\nwith newline");
      expect(req!.bodyJson.description).toBe("Desc\twith tab");
    } finally {
      api.stop();
    }
  });

  test("issues update-action-item fails fast when API key is missing", () => {
    const r = runCli(["issues", "update-action-item", "00000000-0000-0000-0000-000000000000", "--done"], isolatedEnv());
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("API key is required");
  });

  test("issues update-action-item fails when action_item_id is not a valid UUID", () => {
    const r = runCli(["issues", "update-action-item", "invalid-id", "--done"], isolatedEnv({ PGAI_API_KEY: "test-key" }));
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("actionItemId must be a valid UUID");
  });

  test("issues update-action-item fails when no update fields provided", () => {
    const r = runCli(["issues", "update-action-item", "00000000-0000-0000-0000-000000000000"], isolatedEnv({ PGAI_API_KEY: "test-key" }));
    expect(r.status).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("At least one update option is required");
  });

  test("issues update-action-item succeeds with --done flag", async () => {
    const api = await startFakeApi();
    try {
      const r = await runCliAsync(
        ["issues", "update-action-item", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "--done"],
        isolatedEnv({
          PGAI_API_KEY: "test-key",
          PGAI_API_BASE_URL: api.baseUrl,
        })
      );
      expect(r.status).toBe(0);

      const req = api.requests.find((x) => x.pathname.endsWith("/rpc/issue_action_item_update"));
      expect(req).toBeTruthy();
      expect(req!.headers["access-token"]).toBe("test-key");
      expect(req!.bodyJson.action_item_id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      expect(req!.bodyJson.is_done).toBe(true);
    } finally {
      api.stop();
    }
  });

  test("issues update-action-item succeeds with --status flag", async () => {
    const api = await startFakeApi();
    try {
      const r = await runCliAsync(
        ["issues", "update-action-item", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "--status", "approved", "--status-reason", "LGTM"],
        isolatedEnv({
          PGAI_API_KEY: "test-key",
          PGAI_API_BASE_URL: api.baseUrl,
        })
      );
      expect(r.status).toBe(0);

      const req = api.requests.find((x) => x.pathname.endsWith("/rpc/issue_action_item_update"));
      expect(req).toBeTruthy();
      expect(req!.bodyJson.status).toBe("approved");
      expect(req!.bodyJson.status_reason).toBe("LGTM");
    } finally {
      api.stop();
    }
  });
});

