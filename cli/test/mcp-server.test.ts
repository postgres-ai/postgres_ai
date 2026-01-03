import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { handleToolCall, interpretEscapes, type McpToolRequest } from "../lib/mcp-server";
import * as config from "../lib/config";
import * as issues from "../lib/issues";

// Save originals for restoration
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

// Helper to create MCP tool request
function createRequest(name: string, args?: Record<string, unknown>): McpToolRequest {
  return {
    params: {
      name,
      arguments: args,
    },
  };
}

// Helper to extract text from response
function getResponseText(response: { content: Array<{ text: string }> }): string {
  return response.content[0]?.text || "";
}

describe("MCP Server", () => {
  beforeEach(() => {
    // Clear env vars that might interfere
    delete process.env.PGAI_API_KEY;
  });

  afterEach(() => {
    // Restore originals
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  describe("interpretEscapes", () => {
    test("converts \\n to newline", () => {
      expect(interpretEscapes("line1\\nline2")).toBe("line1\nline2");
    });

    test("converts \\t to tab", () => {
      expect(interpretEscapes("col1\\tcol2")).toBe("col1\tcol2");
    });

    test("converts \\r to carriage return", () => {
      expect(interpretEscapes("text\\rmore")).toBe("text\rmore");
    });

    test('converts \\" to double quote', () => {
      expect(interpretEscapes('say \\"hello\\"')).toBe('say "hello"');
    });

    test("converts \\' to single quote", () => {
      expect(interpretEscapes("it\\'s")).toBe("it's");
    });

    test("handles multiple escape sequences", () => {
      expect(interpretEscapes("line1\\nline2\\ttab\\nline3")).toBe("line1\nline2\ttab\nline3");
    });

    test("handles empty string", () => {
      expect(interpretEscapes("")).toBe("");
    });

    test("handles null/undefined gracefully", () => {
      expect(interpretEscapes(null as unknown as string)).toBe("");
      expect(interpretEscapes(undefined as unknown as string)).toBe("");
    });
  });

  describe("API key validation", () => {
    test("returns error when no API key available", async () => {
      // Mock config to return no API key
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: null,
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(createRequest("list_issues"));

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toContain("API key is required");

      readConfigSpy.mockRestore();
    });

    test("uses API key from rootOpts when provided", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: null,
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      // Mock fetch to verify API key is used
      let capturedHeaders: HeadersInit | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedHeaders = options?.headers;
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      await handleToolCall(createRequest("list_issues"), { apiKey: "test-api-key" });

      expect(capturedHeaders).toBeDefined();
      expect((capturedHeaders as Record<string, string>)["access-token"]).toBe("test-api-key");

      readConfigSpy.mockRestore();
    });

    test("falls back to config API key when rootOpts not provided", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "config-api-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let capturedHeaders: HeadersInit | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedHeaders = options?.headers;
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      await handleToolCall(createRequest("list_issues"));

      expect(capturedHeaders).toBeDefined();
      expect((capturedHeaders as Record<string, string>)["access-token"]).toBe("config-api-key");

      readConfigSpy.mockRestore();
    });

    test("uses PGAI_API_KEY env var as fallback", async () => {
      process.env.PGAI_API_KEY = "env-api-key";

      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: null,
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let capturedHeaders: HeadersInit | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedHeaders = options?.headers;
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      await handleToolCall(createRequest("list_issues"));

      expect(capturedHeaders).toBeDefined();
      expect((capturedHeaders as Record<string, string>)["access-token"]).toBe("env-api-key");

      readConfigSpy.mockRestore();
    });
  });

  describe("list_issues tool", () => {
    test("successfully returns issues list as JSON", async () => {
      const mockIssues = [
        { id: "issue-1", title: "First Issue" },
        { id: "issue-2", title: "Second Issue" },
      ];

      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify(mockIssues), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const response = await handleToolCall(createRequest("list_issues"));

      expect(response.isError).toBeUndefined();
      const parsed = JSON.parse(getResponseText(response));
      expect(parsed).toHaveLength(2);
      expect(parsed[0].title).toBe("First Issue");

      readConfigSpy.mockRestore();
    });

    test("handles API errors gracefully", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('{"message": "Unauthorized"}', {
            status: 401,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const response = await handleToolCall(createRequest("list_issues"));

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toContain("401");

      readConfigSpy.mockRestore();
    });
  });

  describe("view_issue tool", () => {
    test("returns error when issue_id is empty", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(createRequest("view_issue", { issue_id: "" }));

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("issue_id is required");

      readConfigSpy.mockRestore();
    });

    test("returns error when issue_id is whitespace only", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(createRequest("view_issue", { issue_id: "   " }));

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("issue_id is required");

      readConfigSpy.mockRestore();
    });

    test("returns error when issue not found", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      // Return null for issue (not found)
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response("null", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const response = await handleToolCall(createRequest("view_issue", { issue_id: "nonexistent-id" }));

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("Issue not found");

      readConfigSpy.mockRestore();
    });

    test("successfully returns combined issue and comments", async () => {
      const mockIssue = { id: "issue-1", title: "Test Issue" };
      const mockComments = [{ id: "comment-1", content: "Test comment" }];

      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let callCount = 0;
      globalThis.fetch = mock((url: string) => {
        callCount++;
        // First call is for the issue, second is for comments
        if (url.includes("issue_get") || callCount === 1) {
          return Promise.resolve(
            new Response(JSON.stringify(mockIssue), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify(mockComments), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      const response = await handleToolCall(createRequest("view_issue", { issue_id: "issue-1" }));

      expect(response.isError).toBeUndefined();
      const parsed = JSON.parse(getResponseText(response));
      expect(parsed.issue.title).toBe("Test Issue");
      expect(parsed.comments).toHaveLength(1);

      readConfigSpy.mockRestore();
    });
  });

  describe("post_issue_comment tool", () => {
    test("returns error when issue_id is empty", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(
        createRequest("post_issue_comment", { issue_id: "", content: "test" })
      );

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("issue_id is required");

      readConfigSpy.mockRestore();
    });

    test("returns error when content is empty", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(
        createRequest("post_issue_comment", { issue_id: "issue-1", content: "" })
      );

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("content is required");

      readConfigSpy.mockRestore();
    });

    test("interprets escape sequences in content", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let capturedBody: string | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedBody = options?.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "comment-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      await handleToolCall(
        createRequest("post_issue_comment", {
          issue_id: "issue-1",
          content: "line1\\nline2\\ttab",
        })
      );

      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.content).toBe("line1\nline2\ttab");

      readConfigSpy.mockRestore();
    });

    test("successfully creates comment with parent_comment_id", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let capturedBody: string | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedBody = options?.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "comment-1", parent_comment_id: "parent-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      const response = await handleToolCall(
        createRequest("post_issue_comment", {
          issue_id: "issue-1",
          content: "Reply content",
          parent_comment_id: "parent-1",
        })
      );

      expect(response.isError).toBeUndefined();
      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.parent_comment_id).toBe("parent-1");

      readConfigSpy.mockRestore();
    });
  });

  describe("create_issue tool", () => {
    test("returns error when title is empty", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: 1,
        defaultProject: null,
      });

      const response = await handleToolCall(createRequest("create_issue", { title: "" }));

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("title is required");

      readConfigSpy.mockRestore();
    });

    test("returns error when title is whitespace only", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: 1,
        defaultProject: null,
      });

      const response = await handleToolCall(createRequest("create_issue", { title: "   " }));

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("title is required");

      readConfigSpy.mockRestore();
    });

    test("returns error when org_id not provided and not in config", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(createRequest("create_issue", { title: "Test Issue" }));

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toContain("org_id is required");

      readConfigSpy.mockRestore();
    });

    test("falls back to config orgId when not provided in args", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: 42,
        defaultProject: null,
      });

      let capturedBody: string | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedBody = options?.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "new-issue" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      await handleToolCall(createRequest("create_issue", { title: "Test Issue" }));

      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.org_id).toBe(42);

      readConfigSpy.mockRestore();
    });

    test("interprets escape sequences in title and description", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: 1,
        defaultProject: null,
      });

      let capturedBody: string | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedBody = options?.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "new-issue" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      await handleToolCall(
        createRequest("create_issue", {
          title: "Title\\nwith newline",
          description: "Desc\\twith tab",
        })
      );

      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.title).toBe("Title\nwith newline");
      expect(parsed.description).toBe("Desc\twith tab");

      readConfigSpy.mockRestore();
    });

    test("successfully creates issue with all parameters", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let capturedBody: string | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedBody = options?.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "new-issue", title: "Test" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      const response = await handleToolCall(
        createRequest("create_issue", {
          title: "Test Issue",
          description: "Test description",
          org_id: 123,
          project_id: 456,
          labels: ["bug", "urgent"],
        })
      );

      expect(response.isError).toBeUndefined();
      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.title).toBe("Test Issue");
      expect(parsed.description).toBe("Test description");
      expect(parsed.org_id).toBe(123);
      expect(parsed.project_id).toBe(456);
      expect(parsed.labels).toEqual(["bug", "urgent"]);

      readConfigSpy.mockRestore();
    });
  });

  describe("update_issue tool", () => {
    test("returns error when issue_id is empty", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(
        createRequest("update_issue", { issue_id: "", title: "New Title" })
      );

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("issue_id is required");

      readConfigSpy.mockRestore();
    });

    test("returns error when no update fields provided", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(createRequest("update_issue", { issue_id: "issue-1" }));

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toContain("At least one field to update is required");

      readConfigSpy.mockRestore();
    });

    test("returns error when status is not 0 or 1", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(
        createRequest("update_issue", { issue_id: "issue-1", status: 2 })
      );

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("status must be 0 (open) or 1 (closed)");

      readConfigSpy.mockRestore();
    });

    test("returns error when status is negative", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(
        createRequest("update_issue", { issue_id: "issue-1", status: -1 })
      );

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("status must be 0 (open) or 1 (closed)");

      readConfigSpy.mockRestore();
    });

    test("interprets escape sequences in title and description", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let capturedBody: string | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedBody = options?.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "issue-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      await handleToolCall(
        createRequest("update_issue", {
          issue_id: "issue-1",
          title: "Updated\\nTitle",
          description: "Updated\\tDescription",
        })
      );

      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.p_title).toBe("Updated\nTitle");
      expect(parsed.p_description).toBe("Updated\tDescription");

      readConfigSpy.mockRestore();
    });

    test("successfully updates with only title", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: "issue-1", title: "New Title" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const response = await handleToolCall(
        createRequest("update_issue", { issue_id: "issue-1", title: "New Title" })
      );

      expect(response.isError).toBeUndefined();

      readConfigSpy.mockRestore();
    });

    test("successfully updates with only status", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let capturedBody: string | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedBody = options?.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "issue-1", status: 1 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      const response = await handleToolCall(
        createRequest("update_issue", { issue_id: "issue-1", status: 1 })
      );

      expect(response.isError).toBeUndefined();
      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.p_status).toBe(1);

      readConfigSpy.mockRestore();
    });

    test("successfully updates with only labels", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let capturedBody: string | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedBody = options?.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "issue-1", labels: ["new-label"] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      const response = await handleToolCall(
        createRequest("update_issue", { issue_id: "issue-1", labels: ["new-label"] })
      );

      expect(response.isError).toBeUndefined();
      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.p_labels).toEqual(["new-label"]);

      readConfigSpy.mockRestore();
    });

    test("accepts status=0 to reopen issue", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let capturedBody: string | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedBody = options?.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "issue-1", status: 0 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      const response = await handleToolCall(
        createRequest("update_issue", { issue_id: "issue-1", status: 0 })
      );

      expect(response.isError).toBeUndefined();
      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.p_status).toBe(0);

      readConfigSpy.mockRestore();
    });
  });

  describe("update_issue_comment tool", () => {
    test("returns error when comment_id is empty", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(
        createRequest("update_issue_comment", { comment_id: "", content: "new content" })
      );

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("comment_id is required");

      readConfigSpy.mockRestore();
    });

    test("returns error when content is empty", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(
        createRequest("update_issue_comment", { comment_id: "comment-1", content: "" })
      );

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toBe("content is required");

      readConfigSpy.mockRestore();
    });

    test("interprets escape sequences in content", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      let capturedBody: string | undefined;
      globalThis.fetch = mock((url: string, options?: RequestInit) => {
        capturedBody = options?.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ id: "comment-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      });

      await handleToolCall(
        createRequest("update_issue_comment", {
          comment_id: "comment-1",
          content: "updated\\ncontent\\twith escapes",
        })
      );

      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.p_content).toBe("updated\ncontent\twith escapes");

      readConfigSpy.mockRestore();
    });

    test("successfully updates comment", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ id: "comment-1", content: "Updated content" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const response = await handleToolCall(
        createRequest("update_issue_comment", {
          comment_id: "comment-1",
          content: "Updated content",
        })
      );

      expect(response.isError).toBeUndefined();
      const parsed = JSON.parse(getResponseText(response));
      expect(parsed.content).toBe("Updated content");

      readConfigSpy.mockRestore();
    });
  });

  describe("unknown tool handling", () => {
    test("returns error for unknown tool name", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: null,
        defaultProject: null,
      });

      const response = await handleToolCall(createRequest("nonexistent_tool"));

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toContain("Unknown tool: nonexistent_tool");

      readConfigSpy.mockRestore();
    });
  });

  describe("error propagation", () => {
    test("propagates API errors through MCP layer", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: 1,
        defaultProject: null,
      });

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('{"message": "Internal Server Error"}', {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const response = await handleToolCall(
        createRequest("create_issue", { title: "Test Issue" })
      );

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toContain("500");

      readConfigSpy.mockRestore();
    });

    test("handles network errors gracefully", async () => {
      const readConfigSpy = spyOn(config, "readConfig").mockReturnValue({
        apiKey: "test-key",
        baseUrl: null,
        orgId: 1,
        defaultProject: null,
      });

      globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));

      const response = await handleToolCall(
        createRequest("create_issue", { title: "Test Issue" })
      );

      expect(response.isError).toBe(true);
      expect(getResponseText(response)).toContain("Network error");

      readConfigSpy.mockRestore();
    });
  });
});
