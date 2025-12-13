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
  assert.ok(plan.steps.some((s) => s.name === "create monitoring user"));
  assert.ok(!plan.steps.some((s) => s.optional));
});

test("buildInitPlan includes alter user when role exists", async () => {
  const plan = await init.buildInitPlan({
    database: "mydb",
    monitoringUser: "postgres_ai_mon",
    monitoringPassword: "pw",
    includeOptionalPermissions: true,
    roleExists: true,
  });

  assert.ok(plan.steps.some((s) => s.name === "update monitoring user password"));
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


