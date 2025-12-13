const test = require("node:test");
const assert = require("node:assert/strict");

// These tests intentionally import the compiled JS output.
// Run via: npm --prefix cli test
const init = require("../dist/lib/init.js");

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

test("buildInitPlan includes create user when role does not exist", async () => {
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: "postgres_ai_mon",
    monitoringPassword: "pw",
    includeOptionalPermissions: false,
    roleExists: false,
  });

  assert.equal(plan.database, "mydb");
  const roleStep = plan.steps.find((s) => s.name === "01.role");
  assert.ok(roleStep);
  assert.match(roleStep.sql, /create\s+user/i);
  assert.ok(!plan.steps.some((s) => s.optional));
});

test("buildInitPlan includes role step when roleExists is omitted", async () => {
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: "postgres_ai_mon",
    monitoringPassword: "pw",
    includeOptionalPermissions: false,
  });
  const roleStep = plan.steps.find((s) => s.name === "01.role");
  assert.ok(roleStep);
  assert.match(roleStep.sql, /do\s+\$\$/i);
});

test("buildInitPlan inlines password safely for CREATE/ALTER ROLE grammar", async () => {
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: "postgres_ai_mon",
    monitoringPassword: "pa'ss",
    includeOptionalPermissions: false,
    roleExists: false,
  });
  const step = plan.steps.find((s) => s.name === "01.role");
  assert.ok(step);
  assert.match(step.sql, /password 'pa''ss'/);
  assert.equal(step.params, undefined);
});

test("buildInitPlan includes alter user when role exists", async () => {
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: "postgres_ai_mon",
    monitoringPassword: "pw",
    includeOptionalPermissions: true,
    roleExists: true,
  });

  const roleStep = plan.steps.find((s) => s.name === "01.role");
  assert.ok(roleStep);
  assert.match(roleStep.sql, /alter\s+user/i);
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

test("resolveAdminConnection error message includes examples", () => {
  assert.throws(() => init.resolveAdminConnection({}), /Examples:/);
});

test("print-sql redaction regex matches password literal with embedded quotes", async () => {
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: "postgres_ai_mon",
    monitoringPassword: "pa'ss",
    includeOptionalPermissions: false,
    roleExists: false,
  });
  const step = plan.steps.find((s) => s.name === "01.role");
  assert.ok(step);
  const redacted = step.sql.replace(/password\s+'(?:''|[^'])*'/gi, "password '<redacted>'");
  assert.match(redacted, /password '<redacted>'/i);
});


