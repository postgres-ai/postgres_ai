import { describe, test, expect, beforeAll } from "bun:test";
import { resolve } from "path";

// Import from source directly since we're using Bun
import * as init from "../lib/init";
const DEFAULT_MONITORING_USER = init.DEFAULT_MONITORING_USER;

function runCli(args: string[], env: Record<string, string> = {}) {
  const cliPath = resolve(import.meta.dir, "..", "bin", "postgres-ai.ts");
  const result = Bun.spawnSync(["bun", cliPath, ...args], {
    env: { ...process.env, ...env },
  });
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function runPgai(args: string[], env: Record<string, string> = {}) {
  const pgaiPath = resolve(import.meta.dir, "..", "..", "pgai", "bin", "pgai.ts");
  const result = Bun.spawnSync(["bun", pgaiPath, ...args], {
    env: { ...process.env, ...env },
  });
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("init module", () => {
  test("maskConnectionString hides password when present", () => {
    const masked = init.maskConnectionString("postgresql://user:secret@localhost:5432/mydb");
    expect(masked).toMatch(/postgresql:\/\/user:\*{5}@localhost:5432\/mydb/);
    expect(masked).not.toMatch(/secret/);
  });

  test("parseLibpqConninfo parses basic host/dbname/user/port/password", () => {
    const cfg = init.parseLibpqConninfo("dbname=mydb host=localhost user=alice port=5432 password=secret");
    expect(cfg.database).toBe("mydb");
    expect(cfg.host).toBe("localhost");
    expect(cfg.user).toBe("alice");
    expect(cfg.port).toBe(5432);
    expect(cfg.password).toBe("secret");
  });

  test("parseLibpqConninfo supports quoted values", () => {
    const cfg = init.parseLibpqConninfo("dbname='my db' host='local host'");
    expect(cfg.database).toBe("my db");
    expect(cfg.host).toBe("local host");
  });

  test("buildInitPlan includes a race-safe role DO block", async () => {
    const plan = await init.buildInitPlan({
      database: "mydb",
      monitoringUser: DEFAULT_MONITORING_USER,
      monitoringPassword: "pw",
      includeOptionalPermissions: false,
    });

    expect(plan.database).toBe("mydb");
    const roleStep = plan.steps.find((s: { name: string }) => s.name === "01.role");
    expect(roleStep).toBeTruthy();
    expect(roleStep.sql).toMatch(/do\s+\$\$/i);
    expect(roleStep.sql).toMatch(/create\s+user/i);
    expect(roleStep.sql).toMatch(/alter\s+user/i);
    expect(plan.steps.some((s: { optional?: boolean }) => s.optional)).toBe(false);
  });

  test("buildInitPlan handles special characters in monitoring user and database identifiers", async () => {
    const monitoringUser = 'user "with" quotes ✓';
    const database = 'db name "with" quotes ✓';
    const plan = await init.buildInitPlan({
      database,
      monitoringUser,
      monitoringPassword: "pw",
      includeOptionalPermissions: false,
    });

    const roleStep = plan.steps.find((s: { name: string }) => s.name === "01.role");
    expect(roleStep).toBeTruthy();
    expect(roleStep.sql).toMatch(/create\s+user\s+"user ""with"" quotes ✓"/i);
    expect(roleStep.sql).toMatch(/alter\s+user\s+"user ""with"" quotes ✓"/i);

    const permStep = plan.steps.find((s: { name: string }) => s.name === "02.permissions");
    expect(permStep).toBeTruthy();
    expect(permStep.sql).toMatch(/grant connect on database "db name ""with"" quotes ✓" to "user ""with"" quotes ✓"/i);
  });

  test("buildInitPlan keeps backslashes in passwords (no unintended escaping)", async () => {
    const pw = String.raw`pw\with\backslash`;
    const plan = await init.buildInitPlan({
      database: "mydb",
      monitoringUser: DEFAULT_MONITORING_USER,
      monitoringPassword: pw,
      includeOptionalPermissions: false,
    });
    const roleStep = plan.steps.find((s: { name: string }) => s.name === "01.role");
    expect(roleStep).toBeTruthy();
    expect(roleStep.sql).toContain(`password '${pw}'`);
  });

  test("buildInitPlan rejects identifiers with null bytes", async () => {
    await expect(
      init.buildInitPlan({
        database: "mydb",
        monitoringUser: "bad\0user",
        monitoringPassword: "pw",
        includeOptionalPermissions: false,
      })
    ).rejects.toThrow(/Identifier cannot contain null bytes/);
  });

  test("buildInitPlan rejects literals with null bytes", async () => {
    await expect(
      init.buildInitPlan({
        database: "mydb",
        monitoringUser: DEFAULT_MONITORING_USER,
        monitoringPassword: "pw\0bad",
        includeOptionalPermissions: false,
      })
    ).rejects.toThrow(/Literal cannot contain null bytes/);
  });

  test("buildInitPlan inlines password safely for CREATE/ALTER ROLE grammar", async () => {
    const plan = await init.buildInitPlan({
      database: "mydb",
      monitoringUser: DEFAULT_MONITORING_USER,
      monitoringPassword: "pa'ss",
      includeOptionalPermissions: false,
    });
    const step = plan.steps.find((s: { name: string }) => s.name === "01.role");
    expect(step).toBeTruthy();
    expect(step.sql).toMatch(/password 'pa''ss'/);
    expect(step.params).toBeUndefined();
  });

  test("buildInitPlan includes optional steps when enabled", async () => {
    const plan = await init.buildInitPlan({
      database: "mydb",
      monitoringUser: DEFAULT_MONITORING_USER,
      monitoringPassword: "pw",
      includeOptionalPermissions: true,
    });
    expect(plan.steps.some((s: { optional?: boolean }) => s.optional)).toBe(true);
  });

  test("resolveAdminConnection accepts positional URI", () => {
    const r = init.resolveAdminConnection({ conn: "postgresql://u:p@h:5432/d" });
    expect(r.clientConfig.connectionString).toBeTruthy();
    expect(r.display).not.toMatch(/:p@/);
  });

  test("resolveAdminConnection accepts positional conninfo", () => {
    const r = init.resolveAdminConnection({ conn: "dbname=mydb host=localhost user=alice" });
    expect(r.clientConfig.database).toBe("mydb");
    expect(r.clientConfig.host).toBe("localhost");
    expect(r.clientConfig.user).toBe("alice");
  });

  test("resolveAdminConnection rejects invalid psql-like port", () => {
    expect(() => init.resolveAdminConnection({ host: "localhost", port: "abc", username: "u", dbname: "d" }))
      .toThrow(/Invalid port value/);
  });

  test("resolveAdminConnection rejects when only PGPASSWORD is provided (no connection details)", () => {
    expect(() => init.resolveAdminConnection({ envPassword: "pw" })).toThrow(/Connection is required/);
  });

  test("resolveAdminConnection rejects when connection is missing", () => {
    expect(() => init.resolveAdminConnection({})).toThrow(/Connection is required/);
  });

  test("resolveMonitoringPassword auto-generates a strong, URL-safe password by default", async () => {
    const r = await init.resolveMonitoringPassword({ monitoringUser: DEFAULT_MONITORING_USER });
    expect(r.generated).toBe(true);
    expect(typeof r.password).toBe("string");
    expect(r.password.length).toBeGreaterThanOrEqual(30);
    expect(r.password).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("applyInitPlan preserves Postgres error fields on step failures", async () => {
    const plan = {
      monitoringUser: DEFAULT_MONITORING_USER,
      database: "mydb",
      steps: [{ name: "01.role", sql: "select 1" }],
    };

    const pgErr = Object.assign(new Error("permission denied to create role"), {
      code: "42501",
      detail: "some detail",
      hint: "some hint",
      schema: "pg_catalog",
      table: "pg_roles",
      constraint: "some_constraint",
      routine: "aclcheck_error",
    });

    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql === "begin;") return { rowCount: 1 };
        if (sql === "rollback;") return { rowCount: 1 };
        if (sql === "select 1") throw pgErr;
        throw new Error(`unexpected sql: ${sql}`);
      },
    };

    try {
      await init.applyInitPlan({ client: client as any, plan: plan as any });
      expect(true).toBe(false); // Should not reach here
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toMatch(/Failed at step "01\.role":/);
      expect(e.code).toBe("42501");
      expect(e.detail).toBe("some detail");
      expect(e.hint).toBe("some hint");
      expect(e.schema).toBe("pg_catalog");
      expect(e.table).toBe("pg_roles");
      expect(e.constraint).toBe("some_constraint");
      expect(e.routine).toBe("aclcheck_error");
    }

    expect(calls).toEqual(["begin;", "select 1", "rollback;"]);
  });

  test("verifyInitSetup runs inside a repeatable read snapshot and rolls back", async () => {
    const calls: string[] = [];
    const client = {
      query: async (sql: string, params?: any) => {
        calls.push(String(sql));

        if (String(sql).toLowerCase().startsWith("begin isolation level repeatable read")) {
          return { rowCount: 1, rows: [] };
        }
        if (String(sql).toLowerCase() === "rollback;") {
          return { rowCount: 1, rows: [] };
        }
        if (String(sql).includes("select rolconfig")) {
          return { rowCount: 1, rows: [{ rolconfig: ['search_path="$user", public, pg_catalog'] }] };
        }
        if (String(sql).includes("from pg_catalog.pg_roles")) {
          return { rowCount: 1, rows: [] };
        }
        if (String(sql).includes("has_database_privilege")) {
          return { rowCount: 1, rows: [{ ok: true }] };
        }
        if (String(sql).includes("pg_has_role")) {
          return { rowCount: 1, rows: [{ ok: true }] };
        }
        if (String(sql).includes("has_table_privilege") && String(sql).includes("pg_catalog.pg_index")) {
          return { rowCount: 1, rows: [{ ok: true }] };
        }
        if (String(sql).includes("to_regclass('public.pg_statistic')")) {
          return { rowCount: 1, rows: [{ ok: true }] };
        }
        if (String(sql).includes("has_table_privilege") && String(sql).includes("public.pg_statistic")) {
          return { rowCount: 1, rows: [{ ok: true }] };
        }
        if (String(sql).includes("has_schema_privilege")) {
          return { rowCount: 1, rows: [{ ok: true }] };
        }

        throw new Error(`unexpected sql: ${sql} params=${JSON.stringify(params)}`);
      },
    };

    const r = await init.verifyInitSetup({
      client: client as any,
      database: "mydb",
      monitoringUser: DEFAULT_MONITORING_USER,
      includeOptionalPermissions: false,
    });
    expect(r.ok).toBe(true);
    expect(r.missingRequired.length).toBe(0);

    expect(calls.length).toBeGreaterThan(2);
    expect(calls[0].toLowerCase()).toMatch(/^begin isolation level repeatable read/);
    expect(calls[calls.length - 1].toLowerCase()).toBe("rollback;");
  });

  test("redactPasswordsInSql redacts password literals with embedded quotes", async () => {
    const plan = await init.buildInitPlan({
      database: "mydb",
      monitoringUser: DEFAULT_MONITORING_USER,
      monitoringPassword: "pa'ss",
      includeOptionalPermissions: false,
    });
    const step = plan.steps.find((s: { name: string }) => s.name === "01.role");
    expect(step).toBeTruthy();
    const redacted = init.redactPasswordsInSql(step.sql);
    expect(redacted).toMatch(/password '<redacted>'/i);
  });
});

describe("CLI commands", () => {
  test("cli: prepare-db with missing connection prints help/options", () => {
    const r = runCli(["prepare-db"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--print-sql/);
    expect(r.stderr).toMatch(/--monitoring-user/);
  });

  test("cli: prepare-db --print-sql works without connection (offline mode)", () => {
    const r = runCli(["prepare-db", "--print-sql", "-d", "mydb", "--password", "monpw"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/SQL plan \(offline; not connected\)/);
    expect(r.stdout).toMatch(new RegExp(`grant connect on database "mydb" to "${DEFAULT_MONITORING_USER}"`, "i"));
  });

  test("pgai wrapper forwards to postgresai CLI", () => {
    const r = runPgai(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/postgresai|PostgresAI/i);
  });

  test("cli: prepare-db command exists and shows help", () => {
    const r = runCli(["prepare-db", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/monitoring user/i);
    expect(r.stdout).toMatch(/--print-sql/);
  });

  test("cli: mon local-install command exists and shows help", () => {
    const r = runCli(["mon", "local-install", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--demo/);
    expect(r.stdout).toMatch(/--api-key/);
  });

  test("cli: auth --help shows --set-key option", () => {
    const r = runCli(["auth", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--set-key/);
  });
});
