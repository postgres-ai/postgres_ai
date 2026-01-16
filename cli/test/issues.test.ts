import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createIssue, updateIssue, updateIssueComment } from "../lib/issues";

// Mock fetch globally
const originalFetch = globalThis.fetch;

describe("createIssue", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("throws when apiKey is missing", async () => {
    await expect(
      createIssue({
        apiKey: "",
        apiBaseUrl: "https://api.example.com",
        title: "Test Issue",
        orgId: 1,
      })
    ).rejects.toThrow("API key is required");
  });

  test("throws when title is missing", async () => {
    await expect(
      createIssue({
        apiKey: "test-key",
        apiBaseUrl: "https://api.example.com",
        title: "",
        orgId: 1,
      })
    ).rejects.toThrow("title is required");
  });

  test("throws when orgId is not a number", async () => {
    await expect(
      createIssue({
        apiKey: "test-key",
        apiBaseUrl: "https://api.example.com",
        title: "Test Issue",
        orgId: undefined as unknown as number,
      })
    ).rejects.toThrow("orgId is required");
  });

  test("accepts orgId=0 as valid", async () => {
    const mockResponse = {
      id: "test-id",
      title: "Test Issue",
      description: null,
      created_at: "2025-01-01T00:00:00Z",
      status: 0,
      project_id: null,
      labels: null,
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as unknown as typeof fetch;

    const result = await createIssue({
      apiKey: "test-key",
      apiBaseUrl: "https://api.example.com",
      title: "Test Issue",
      orgId: 0,
    });

    expect(result.id).toBe("test-id");
  });

  test("makes correct API call with all parameters", async () => {
    const mockResponse = {
      id: "test-id",
      title: "Test Issue",
      description: "Test description",
      created_at: "2025-01-01T00:00:00Z",
      status: 0,
      project_id: 123,
      labels: ["bug", "urgent"],
    };

    let capturedRequest: { url: string; options: RequestInit } | null = null;

    globalThis.fetch = mock((url: string, options: RequestInit) => {
      capturedRequest = { url, options };
      return Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }) as unknown as typeof fetch;

    const result = await createIssue({
      apiKey: "test-key",
      apiBaseUrl: "https://api.example.com",
      title: "Test Issue",
      orgId: 1,
      description: "Test description",
      projectId: 123,
      labels: ["bug", "urgent"],
    });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.url).toBe("https://api.example.com/rpc/issue_create");
    expect(capturedRequest!.options.method).toBe("POST");

    const body = JSON.parse(capturedRequest!.options.body as string);
    expect(body.title).toBe("Test Issue");
    expect(body.org_id).toBe(1);
    expect(body.description).toBe("Test description");
    expect(body.project_id).toBe(123);
    expect(body.labels).toEqual(["bug", "urgent"]);

    expect(result).toEqual(mockResponse);
  });

  test("handles API error response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"message": "Unauthorized"}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as unknown as typeof fetch;

    await expect(
      createIssue({
        apiKey: "invalid-key",
        apiBaseUrl: "https://api.example.com",
        title: "Test Issue",
        orgId: 1,
      })
    ).rejects.toThrow(/Failed to create issue/);
  });
});

describe("updateIssue", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("throws when apiKey is missing", async () => {
    await expect(
      updateIssue({
        apiKey: "",
        apiBaseUrl: "https://api.example.com",
        issueId: "test-id",
        title: "Updated Title",
      })
    ).rejects.toThrow("API key is required");
  });

  test("throws when issueId is missing", async () => {
    await expect(
      updateIssue({
        apiKey: "test-key",
        apiBaseUrl: "https://api.example.com",
        issueId: "",
        title: "Updated Title",
      })
    ).rejects.toThrow("issueId is required");
  });

  test("throws when no update fields are provided", async () => {
    await expect(
      updateIssue({
        apiKey: "test-key",
        apiBaseUrl: "https://api.example.com",
        issueId: "test-id",
      })
    ).rejects.toThrow("At least one field to update is required");
  });

  test("accepts update with only title", async () => {
    const mockResponse = {
      id: "test-id",
      title: "Updated Title",
      description: null,
      status: 0,
      updated_at: "2025-01-01T00:00:00Z",
      labels: null,
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as unknown as typeof fetch;

    const result = await updateIssue({
      apiKey: "test-key",
      apiBaseUrl: "https://api.example.com",
      issueId: "test-id",
      title: "Updated Title",
    });

    expect(result.title).toBe("Updated Title");
  });

  test("accepts update with only description", async () => {
    const mockResponse = {
      id: "test-id",
      title: "Original Title",
      description: "New description",
      status: 0,
      updated_at: "2025-01-01T00:00:00Z",
      labels: null,
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as unknown as typeof fetch;

    const result = await updateIssue({
      apiKey: "test-key",
      apiBaseUrl: "https://api.example.com",
      issueId: "test-id",
      description: "New description",
    });

    expect(result.description).toBe("New description");
  });

  test("accepts update with only status", async () => {
    const mockResponse = {
      id: "test-id",
      title: "Title",
      description: null,
      status: 1,
      updated_at: "2025-01-01T00:00:00Z",
      labels: null,
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as unknown as typeof fetch;

    const result = await updateIssue({
      apiKey: "test-key",
      apiBaseUrl: "https://api.example.com",
      issueId: "test-id",
      status: 1,
    });

    expect(result.status).toBe(1);
  });

  test("accepts update with only labels", async () => {
    const mockResponse = {
      id: "test-id",
      title: "Title",
      description: null,
      status: 0,
      updated_at: "2025-01-01T00:00:00Z",
      labels: ["new-label"],
    };

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as unknown as typeof fetch;

    const result = await updateIssue({
      apiKey: "test-key",
      apiBaseUrl: "https://api.example.com",
      issueId: "test-id",
      labels: ["new-label"],
    });

    expect(result.labels).toEqual(["new-label"]);
  });

  test("makes correct API call with all parameters", async () => {
    const mockResponse = {
      id: "test-id",
      title: "Updated Title",
      description: "Updated description",
      status: 1,
      updated_at: "2025-01-01T00:00:00Z",
      labels: ["bug"],
    };

    let capturedRequest: { url: string; options: RequestInit } | null = null;

    globalThis.fetch = mock((url: string, options: RequestInit) => {
      capturedRequest = { url, options };
      return Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }) as unknown as typeof fetch;

    await updateIssue({
      apiKey: "test-key",
      apiBaseUrl: "https://api.example.com",
      issueId: "test-id",
      title: "Updated Title",
      description: "Updated description",
      status: 1,
      labels: ["bug"],
    });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.url).toBe("https://api.example.com/rpc/issue_update");
    expect(capturedRequest!.options.method).toBe("POST");

    const body = JSON.parse(capturedRequest!.options.body as string);
    expect(body.p_id).toBe("test-id");
    expect(body.p_title).toBe("Updated Title");
    expect(body.p_description).toBe("Updated description");
    expect(body.p_status).toBe(1);
    expect(body.p_labels).toEqual(["bug"]);
  });

  test("handles API error response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"message": "Not found"}', {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as unknown as typeof fetch;

    await expect(
      updateIssue({
        apiKey: "test-key",
        apiBaseUrl: "https://api.example.com",
        issueId: "nonexistent-id",
        title: "Updated Title",
      })
    ).rejects.toThrow(/Failed to update issue/);
  });
});

describe("updateIssueComment", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("throws when apiKey is missing", async () => {
    await expect(
      updateIssueComment({
        apiKey: "",
        apiBaseUrl: "https://api.example.com",
        commentId: "test-id",
        content: "Updated content",
      })
    ).rejects.toThrow("API key is required");
  });

  test("throws when commentId is missing", async () => {
    await expect(
      updateIssueComment({
        apiKey: "test-key",
        apiBaseUrl: "https://api.example.com",
        commentId: "",
        content: "Updated content",
      })
    ).rejects.toThrow("commentId is required");
  });

  test("throws when content is missing", async () => {
    await expect(
      updateIssueComment({
        apiKey: "test-key",
        apiBaseUrl: "https://api.example.com",
        commentId: "test-id",
        content: "",
      })
    ).rejects.toThrow("content is required");
  });

  test("makes correct API call", async () => {
    const mockResponse = {
      id: "test-id",
      issue_id: "issue-id",
      content: "Updated content",
      updated_at: "2025-01-01T00:00:00Z",
    };

    let capturedRequest: { url: string; options: RequestInit } | null = null;

    globalThis.fetch = mock((url: string, options: RequestInit) => {
      capturedRequest = { url, options };
      return Promise.resolve(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }) as unknown as typeof fetch;

    const result = await updateIssueComment({
      apiKey: "test-key",
      apiBaseUrl: "https://api.example.com",
      commentId: "test-id",
      content: "Updated content",
    });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.url).toBe("https://api.example.com/rpc/issue_comment_update");
    expect(capturedRequest!.options.method).toBe("POST");

    const body = JSON.parse(capturedRequest!.options.body as string);
    expect(body.p_id).toBe("test-id");
    expect(body.p_content).toBe("Updated content");

    expect(result).toEqual(mockResponse);
  });

  test("handles API error response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"message": "Not found"}', {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as unknown as typeof fetch;

    await expect(
      updateIssueComment({
        apiKey: "test-key",
        apiBaseUrl: "https://api.example.com",
        commentId: "nonexistent-id",
        content: "Updated content",
      })
    ).rejects.toThrow(/Failed to update issue comment/);
  });
});
