import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import {
  resolveSupabaseConfig,
  extractProjectRefFromUrl,
  SupabaseClient,
  type PgCompatibleError,
} from "../lib/supabase";

describe("Supabase module", () => {
  describe("extractProjectRefFromUrl", () => {
    test("extracts project ref from standard Supabase URL", () => {
      const url =
        "postgresql://postgres:password@db.abcdefghij.supabase.co:5432/postgres";
      expect(extractProjectRefFromUrl(url)).toBe("abcdefghij");
    });

    test("extracts project ref from Supabase URL without db. prefix", () => {
      const url =
        "postgresql://postgres:password@abcdefghij.supabase.co:5432/postgres";
      expect(extractProjectRefFromUrl(url)).toBe("abcdefghij");
    });

    test("extracts project ref from pooler URL", () => {
      const url =
        "postgresql://postgres:password@abcdefghij.pooler.supabase.com:6543/postgres";
      expect(extractProjectRefFromUrl(url)).toBe("abcdefghij");
    });

    test("returns undefined for non-Supabase URL", () => {
      const url = "postgresql://postgres:password@localhost:5432/postgres";
      expect(extractProjectRefFromUrl(url)).toBeUndefined();
    });

    test("returns undefined for RDS URL", () => {
      const url =
        "postgresql://postgres:password@mydb.cluster-xyz.us-east-1.rds.amazonaws.com:5432/postgres";
      expect(extractProjectRefFromUrl(url)).toBeUndefined();
    });

    test("returns undefined for invalid URL", () => {
      const url = "not a valid url";
      expect(extractProjectRefFromUrl(url)).toBeUndefined();
    });

    test("handles URL with special characters in password", () => {
      const url =
        "postgresql://postgres:p%40ss%2Fw0rd@db.myproject.supabase.co:5432/postgres";
      expect(extractProjectRefFromUrl(url)).toBe("myproject");
    });
  });

  describe("resolveSupabaseConfig", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Reset env before each test
      process.env = { ...originalEnv };
      delete process.env.SUPABASE_ACCESS_TOKEN;
      delete process.env.SUPABASE_PROJECT_REF;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    test("resolves config from options", () => {
      const config = resolveSupabaseConfig({
        accessToken: "my-token",
        projectRef: "my-project",
      });
      expect(config.accessToken).toBe("my-token");
      expect(config.projectRef).toBe("my-project");
    });

    test("resolves config from environment variables", () => {
      process.env.SUPABASE_ACCESS_TOKEN = "env-token";
      process.env.SUPABASE_PROJECT_REF = "env-project";

      const config = resolveSupabaseConfig({});
      expect(config.accessToken).toBe("env-token");
      expect(config.projectRef).toBe("env-project");
    });

    test("options take precedence over environment variables", () => {
      process.env.SUPABASE_ACCESS_TOKEN = "env-token";
      process.env.SUPABASE_PROJECT_REF = "env-project";

      const config = resolveSupabaseConfig({
        accessToken: "opts-token",
        projectRef: "opts-project",
      });
      expect(config.accessToken).toBe("opts-token");
      expect(config.projectRef).toBe("opts-project");
    });

    test("throws error when access token is missing", () => {
      expect(() =>
        resolveSupabaseConfig({
          projectRef: "my-project",
        })
      ).toThrow(/access token is required/i);
    });

    test("throws error when project ref is missing", () => {
      expect(() =>
        resolveSupabaseConfig({
          accessToken: "my-token",
        })
      ).toThrow(/project reference is required/i);
    });

    test("trims whitespace from values", () => {
      const config = resolveSupabaseConfig({
        accessToken: "  my-token  ",
        projectRef: "  my-project  ",
      });
      expect(config.accessToken).toBe("my-token");
      expect(config.projectRef).toBe("my-project");
    });
  });

  describe("SupabaseClient", () => {
    test("throws error when project ref is empty", () => {
      expect(() => new SupabaseClient({ projectRef: "", accessToken: "token" })).toThrow(
        /project reference is required/i
      );
    });

    test("throws error when access token is empty", () => {
      expect(() => new SupabaseClient({ projectRef: "ref", accessToken: "" })).toThrow(
        /access token is required/i
      );
    });

    describe("query method", () => {
      const originalFetch = globalThis.fetch;
      let mockFetch: ReturnType<typeof mock>;

      beforeEach(() => {
        mockFetch = mock(() =>
          Promise.resolve(new Response(JSON.stringify([{ db: "postgres" }]), { status: 200 }))
        );
        globalThis.fetch = mockFetch as unknown as typeof fetch;
      });

      afterEach(() => {
        globalThis.fetch = originalFetch;
      });

      test("makes correct API request", async () => {
        const client = new SupabaseClient({
          projectRef: "myproject",
          accessToken: "mytoken",
        });

        await client.query("SELECT 1", true);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(
          "https://api.supabase.com/v1/projects/myproject/database/query"
        );
        expect(options.method).toBe("POST");
        expect(options.headers).toEqual({
          "Content-Type": "application/json",
          Authorization: "Bearer mytoken",
        });
        const body = JSON.parse(options.body as string);
        expect(body.query).toBe("SELECT 1");
        expect(body.read_only).toBe(true);
      });

      test("returns rows from successful response", async () => {
        mockFetch = mock(() =>
          Promise.resolve(
            new Response(JSON.stringify([{ id: 1, name: "test" }]), { status: 200 })
          )
        );
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const client = new SupabaseClient({
          projectRef: "myproject",
          accessToken: "mytoken",
        });

        const result = await client.query("SELECT * FROM test");
        expect(result.rows).toEqual([{ id: 1, name: "test" }]);
        expect(result.rowCount).toBe(1);
      });

      test("handles empty result", async () => {
        mockFetch = mock(() =>
          Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
        );
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const client = new SupabaseClient({
          projectRef: "myproject",
          accessToken: "mytoken",
        });

        const result = await client.query("SELECT * FROM empty_table");
        expect(result.rows).toEqual([]);
        expect(result.rowCount).toBe(0);
      });

      test("throws PgCompatibleError on HTTP error", async () => {
        mockFetch = mock(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "42501",
                  message: "permission denied",
                  details: "Not authorized",
                },
              }),
              { status: 403 }
            )
          )
        );
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const client = new SupabaseClient({
          projectRef: "myproject",
          accessToken: "mytoken",
        });

        try {
          await client.query("SELECT * FROM secret_table");
          expect(true).toBe(false); // Should not reach here
        } catch (e) {
          const err = e as PgCompatibleError;
          expect(err.message).toBe("permission denied");
          expect(err.code).toBe("42501");
          expect(err.detail).toBe("Not authorized");
          expect(err.httpStatus).toBe(403);
        }
      });

      test("throws error on non-JSON response", async () => {
        mockFetch = mock(() =>
          Promise.resolve(new Response("Internal Server Error", { status: 500 }))
        );
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const client = new SupabaseClient({
          projectRef: "myproject",
          accessToken: "mytoken",
        });

        try {
          await client.query("SELECT 1");
          expect(true).toBe(false);
        } catch (e) {
          const err = e as PgCompatibleError;
          expect(err.message).toContain("non-JSON response");
          expect(err.httpStatus).toBe(500);
        }
      });

      test("maps Supabase error codes to PostgreSQL codes", async () => {
        mockFetch = mock(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "PGRST200",
                  message: "table not found",
                },
              }),
              { status: 404 }
            )
          )
        );
        globalThis.fetch = mockFetch as unknown as typeof fetch;

        const client = new SupabaseClient({
          projectRef: "myproject",
          accessToken: "mytoken",
        });

        try {
          await client.query("SELECT * FROM nonexistent");
          expect(true).toBe(false);
        } catch (e) {
          const err = e as PgCompatibleError;
          expect(err.code).toBe("42P01"); // undefined_table
        }
      });
    });

    describe("testConnection method", () => {
      const originalFetch = globalThis.fetch;

      afterEach(() => {
        globalThis.fetch = originalFetch;
      });

      test("returns database and version info", async () => {
        globalThis.fetch = mock(() =>
          Promise.resolve(
            new Response(
              JSON.stringify([
                { db: "postgres", version: "PostgreSQL 15.1" },
              ]),
              { status: 200 }
            )
          )
        ) as unknown as typeof fetch;

        const client = new SupabaseClient({
          projectRef: "myproject",
          accessToken: "mytoken",
        });

        const result = await client.testConnection();
        expect(result.database).toBe("postgres");
        expect(result.version).toBe("PostgreSQL 15.1");
      });
    });

    describe("getCurrentDatabase method", () => {
      const originalFetch = globalThis.fetch;

      afterEach(() => {
        globalThis.fetch = originalFetch;
      });

      test("returns current database name", async () => {
        globalThis.fetch = mock(() =>
          Promise.resolve(
            new Response(JSON.stringify([{ db: "mydb" }]), { status: 200 })
          )
        ) as unknown as typeof fetch;

        const client = new SupabaseClient({
          projectRef: "myproject",
          accessToken: "mytoken",
        });

        const result = await client.getCurrentDatabase();
        expect(result).toBe("mydb");
      });
    });
  });
});
