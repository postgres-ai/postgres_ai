const test = require("node:test");
const assert = require("node:assert/strict");

// These tests intentionally import the compiled JS output.
// Run via: npm --prefix cli test
const init = require("../dist/lib/init.js");
const DEFAULT_MONITORING_USER = init.DEFAULT_MONITORING_USER;

function runCli(args, env = {}) {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const node = process.execPath;
  const cliPath = path.resolve(__dirname, "..", "dist", "bin", "postgres-ai.js");
  return spawnSync(node, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runPgai(args, env = {}) {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const node = process.execPath;
  const pgaiPath = path.resolve(__dirname, "..", "..", "pgai", "bin", "pgai.js");
  return spawnSync(node, [pgaiPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("maskConnectionString hides password when present", () => {
  const masked = init.maskConnectionString("postgresql://user:secret@localhost:5432/mydb");
  assert.match(masked, /postgresql:\/\/user:\*{5}@localhost:5432\/mydb/);
  assert.doesNotMatch(masked, /secret/);
});

test("parseLibpqConninfo parses basic host/dbname/user/port/password", () => {
  const cfg = init.parseLibpqConninfo("dbname=mydb host=localhost user=alice port=5432 password=secret");
  assert.equal(cfg.database, "mydb");
  assert.equal(cfg.host, "localhost");
  assert.equal(cfg.user, "alice");
  assert.equal(cfg.port, 5432);
  assert.equal(cfg.password, "secret");
});

test("parseLibpqConninfo supports quoted values", () => {
  const cfg = init.parseLibpqConninfo("dbname='my db' host='local host'");
  assert.equal(cfg.database, "my db");
  assert.equal(cfg.host, "local host");
});

test("buildInitPlan includes a race-safe role DO block", async () => {
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: DEFAULT_MONITORING_USER,
    monitoringPassword: "pw",
    includeOptionalPermissions: false,
  });

  assert.equal(plan.database, "mydb");
  const roleStep = plan.steps.find((s) => s.name === "01.role");
  assert.ok(roleStep);
  assert.match(roleStep.sql, /do\s+\$\$/i);
  assert.match(roleStep.sql, /create\s+user/i);
  assert.match(roleStep.sql, /alter\s+user/i);
  assert.ok(!plan.steps.some((s) => s.optional));
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

  const roleStep = plan.steps.find((s) => s.name === "01.role");
  assert.ok(roleStep);
  // Double quotes inside identifiers must be doubled.
  assert.match(roleStep.sql, /create\s+user\s+"user ""with"" quotes ✓"/i);
  assert.match(roleStep.sql, /alter\s+user\s+"user ""with"" quotes ✓"/i);

  const permStep = plan.steps.find((s) => s.name === "02.permissions");
  assert.ok(permStep);
  assert.match(permStep.sql, /grant connect on database "db name ""with"" quotes ✓" to "user ""with"" quotes ✓"/i);
});

test("buildInitPlan keeps backslashes in passwords (no unintended escaping)", async () => {
  const pw = String.raw`pw\with\backslash`;
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: DEFAULT_MONITORING_USER,
    monitoringPassword: pw,
    includeOptionalPermissions: false,
  });
  const roleStep = plan.steps.find((s) => s.name === "01.role");
  assert.ok(roleStep);
  assert.ok(roleStep.sql.includes(`password '${pw}'`));
});

test("buildInitPlan rejects identifiers with null bytes", async () => {
  await assert.rejects(
    () =>
      init.buildInitPlan({
        database: "mydb",
        monitoringUser: "bad\0user",
        monitoringPassword: "pw",
        includeOptionalPermissions: false,
      }),
    /Identifier cannot contain null bytes/
  );
});

test("buildInitPlan rejects literals with null bytes", async () => {
  await assert.rejects(
    () =>
      init.buildInitPlan({
        database: "mydb",
        monitoringUser: DEFAULT_MONITORING_USER,
        monitoringPassword: "pw\0bad",
        includeOptionalPermissions: false,
      }),
    /Literal cannot contain null bytes/
  );
});

test("buildInitPlan inlines password safely for CREATE/ALTER ROLE grammar", async () => {
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: DEFAULT_MONITORING_USER,
    monitoringPassword: "pa'ss",
    includeOptionalPermissions: false,
  });
  const step = plan.steps.find((s) => s.name === "01.role");
  assert.ok(step);
  assert.match(step.sql, /password 'pa''ss'/);
  assert.equal(step.params, undefined);
});

test("buildInitPlan includes optional steps when enabled", async () => {
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: DEFAULT_MONITORING_USER,
    monitoringPassword: "pw",
    includeOptionalPermissions: true,
  });
  assert.ok(plan.steps.some((s) => s.optional));
});

test("resolveAdminConnection accepts positional URI", () => {
  const r = init.resolveAdminConnection({ conn: "postgresql://u:p@h:5432/d" });
  assert.ok(r.clientConfig.connectionString);
  assert.doesNotMatch(r.display, /:p@/);
});

test("resolveAdminConnection accepts positional conninfo", () => {
  const r = init.resolveAdminConnection({ conn: "dbname=mydb host=localhost user=alice" });
  assert.equal(r.clientConfig.database, "mydb");
  assert.equal(r.clientConfig.host, "localhost");
  assert.equal(r.clientConfig.user, "alice");
});

test("resolveAdminConnection rejects invalid psql-like port", () => {
  assert.throws(
    () => init.resolveAdminConnection({ host: "localhost", port: "abc", username: "u", dbname: "d" }),
    /Invalid port value/
  );
});

test("resolveAdminConnection rejects when only PGPASSWORD is provided (no connection details)", () => {
  assert.throws(() => init.resolveAdminConnection({ envPassword: "pw" }), /Connection is required/);
});

test("resolveAdminConnection rejects when connection is missing", () => {
  assert.throws(() => init.resolveAdminConnection({}), /Connection is required/);
});

test("cli: prepare-db with missing connection prints help/options", () => {
  const r = runCli(["prepare-db"]);
  assert.notEqual(r.status, 0);
  // We should show options, not just the error message.
  assert.match(r.stderr, /--print-sql/);
  assert.match(r.stderr, /--monitoring-user/);
});

test("resolveMonitoringPassword auto-generates a strong, URL-safe password by default", async () => {
  const r = await init.resolveMonitoringPassword({ monitoringUser: DEFAULT_MONITORING_USER });
  assert.equal(r.generated, true);
  assert.ok(typeof r.password === "string" && r.password.length >= 30);
  assert.match(r.password, /^[A-Za-z0-9_-]+$/);
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

  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql === "begin;") return { rowCount: 1 };
      if (sql === "rollback;") return { rowCount: 1 };
      if (sql === "select 1") throw pgErr;
      throw new Error(`unexpected sql: ${sql}`);
    },
  };

  await assert.rejects(
    () => init.applyInitPlan({ client, plan }),
    (e) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /Failed at step "01\.role":/);
      assert.equal(e.code, "42501");
      assert.equal(e.detail, "some detail");
      assert.equal(e.hint, "some hint");
      assert.equal(e.schema, "pg_catalog");
      assert.equal(e.table, "pg_roles");
      assert.equal(e.constraint, "some_constraint");
      assert.equal(e.routine, "aclcheck_error");
      return true;
    }
  );

  assert.deepEqual(calls, ["begin;", "select 1", "rollback;"]);
});

test("verifyInitSetup runs inside a repeatable read snapshot and rolls back", async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
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
    client,
    database: "mydb",
    monitoringUser: DEFAULT_MONITORING_USER,
    includeOptionalPermissions: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.missingRequired.length, 0);

  assert.ok(calls.length > 2);
  assert.match(calls[0].toLowerCase(), /^begin isolation level repeatable read/);
  assert.equal(calls[calls.length - 1].toLowerCase(), "rollback;");
});

test("redactPasswordsInSql redacts password literals with embedded quotes", async () => {
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: DEFAULT_MONITORING_USER,
    monitoringPassword: "pa'ss",
    includeOptionalPermissions: false,
  });
  const step = plan.steps.find((s) => s.name === "01.role");
  assert.ok(step);
  const redacted = init.redactPasswordsInSql(step.sql);
  assert.match(redacted, /password '<redacted>'/i);
});

test("cli: prepare-db --print-sql works without connection (offline mode)", () => {
  const r = runCli(["prepare-db", "--print-sql", "-d", "mydb", "--password", "monpw"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /SQL plan \(offline; not connected\)/);
  assert.match(r.stdout, new RegExp(`grant connect on database "mydb" to "${DEFAULT_MONITORING_USER}"`, "i"));
});

test("pgai wrapper forwards to postgresai CLI", () => {
  const r = runPgai(["--help"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /postgresai|PostgresAI/i);
});

test("cli: prepare-db command exists and shows help", () => {
  const r = runCli(["prepare-db", "--help"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /monitoring user/i);
  assert.match(r.stdout, /--print-sql/);
});

test("cli: prepare-db with missing connection prints help/options", () => {
  const r = runCli(["prepare-db"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--print-sql/);
  assert.match(r.stderr, /--monitoring-user/);
});

test("cli: prepare-db --print-sql works without connection (offline mode)", () => {
  const r = runCli(["prepare-db", "--print-sql", "-d", "mydb", "--password", "monpw"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /SQL plan \(offline; not connected\)/);
  assert.match(r.stdout, new RegExp(`grant connect on database "mydb" to "${DEFAULT_MONITORING_USER}"`, "i"));
});

test("cli: mon local-install command exists and shows help", () => {
  const r = runCli(["mon", "local-install", "--help"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /--demo/);
  assert.match(r.stdout, /--api-key/);
});

// Auth --set-key tests
test("cli: auth --set-key stores key without OAuth", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  
  // Use a temp directory for config to avoid modifying user's actual config
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pgai-auth-test-"));
  
  try {
    // Create the postgresai subdirectory so we know exactly where config goes
    const postgresaiDir = path.join(tmpDir, "postgresai");
    fs.mkdirSync(postgresaiDir, { recursive: true });
    
    // Set XDG_CONFIG_HOME to redirect config to temp dir
    const r = runCli(["auth", "--set-key", "test-api-key-12345"], {
      XDG_CONFIG_HOME: tmpDir,
      // Also clear HOME to prevent fallbacks
      HOME: tmpDir,
    });
    
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /API key saved/i);
    
    // Verify the config file was created with the API key
    const actualConfigPath = path.join(postgresaiDir, "config.json");
    assert.ok(fs.existsSync(actualConfigPath), "Config file should exist at " + actualConfigPath);
    
    const config = JSON.parse(fs.readFileSync(actualConfigPath, "utf8"));
    assert.equal(config.apiKey, "test-api-key-12345");
  } finally {
    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cli: auth --help shows --set-key option", () => {
  const r = runCli(["auth", "--help"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /--set-key/);
});

