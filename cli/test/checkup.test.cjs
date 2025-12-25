const test = require("node:test");
const assert = require("node:assert/strict");

// These tests intentionally import the compiled JS output.
// Run via: npm --prefix cli test
const checkup = require("../dist/lib/checkup.js");

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

// Unit tests for parseVersionNum
test("parseVersionNum parses PG 16.3 version number", () => {
  const result = checkup.parseVersionNum("160003");
  assert.equal(result.major, "16");
  assert.equal(result.minor, "3");
});

test("parseVersionNum parses PG 15.7 version number", () => {
  const result = checkup.parseVersionNum("150007");
  assert.equal(result.major, "15");
  assert.equal(result.minor, "7");
});

test("parseVersionNum parses PG 14.12 version number", () => {
  const result = checkup.parseVersionNum("140012");
  assert.equal(result.major, "14");
  assert.equal(result.minor, "12");
});

test("parseVersionNum handles empty string", () => {
  const result = checkup.parseVersionNum("");
  assert.equal(result.major, "");
  assert.equal(result.minor, "");
});

test("parseVersionNum handles null/undefined", () => {
  const result = checkup.parseVersionNum(null);
  assert.equal(result.major, "");
  assert.equal(result.minor, "");
});

test("parseVersionNum handles short string", () => {
  const result = checkup.parseVersionNum("123");
  assert.equal(result.major, "");
  assert.equal(result.minor, "");
});

// Unit tests for createBaseReport
test("createBaseReport creates correct structure", () => {
  const report = checkup.createBaseReport("A002", "Postgres major version", "test-node");

  assert.equal(report.checkId, "A002");
  assert.equal(report.checkTitle, "Postgres major version");
  assert.equal(report.version, null);
  assert.equal(report.build_ts, null);
  assert.equal(report.nodes.primary, "test-node");
  assert.deepEqual(report.nodes.standbys, []);
  assert.deepEqual(report.results, {});
  assert.ok(typeof report.timestamptz === "string");
  // Verify timestamp is ISO format
  assert.ok(new Date(report.timestamptz).toISOString() === report.timestamptz);
});

test("createBaseReport uses provided node name", () => {
  const report = checkup.createBaseReport("A003", "Postgres settings", "my-custom-node");
  assert.equal(report.nodes.primary, "my-custom-node");
});

// Tests for CHECK_INFO
test("CHECK_INFO contains A002", () => {
  assert.ok("A002" in checkup.CHECK_INFO);
  assert.equal(checkup.CHECK_INFO.A002, "Postgres major version");
});

test("CHECK_INFO contains A003", () => {
  assert.ok("A003" in checkup.CHECK_INFO);
  assert.equal(checkup.CHECK_INFO.A003, "Postgres settings");
});

test("CHECK_INFO contains A013", () => {
  assert.ok("A013" in checkup.CHECK_INFO);
  assert.equal(checkup.CHECK_INFO.A013, "Postgres minor version");
});

// Tests for REPORT_GENERATORS
test("REPORT_GENERATORS has generator for A002", () => {
  assert.ok("A002" in checkup.REPORT_GENERATORS);
  assert.equal(typeof checkup.REPORT_GENERATORS.A002, "function");
});

test("REPORT_GENERATORS has generator for A003", () => {
  assert.ok("A003" in checkup.REPORT_GENERATORS);
  assert.equal(typeof checkup.REPORT_GENERATORS.A003, "function");
});

test("REPORT_GENERATORS has generator for A013", () => {
  assert.ok("A013" in checkup.REPORT_GENERATORS);
  assert.equal(typeof checkup.REPORT_GENERATORS.A013, "function");
});

test("REPORT_GENERATORS and CHECK_INFO have same keys", () => {
  const generatorKeys = Object.keys(checkup.REPORT_GENERATORS).sort();
  const infoKeys = Object.keys(checkup.CHECK_INFO).sort();
  assert.deepEqual(generatorKeys, infoKeys);
});

// Tests for METRICS_SQL
test("METRICS_SQL.settings queries pg_settings", () => {
  assert.ok(checkup.METRICS_SQL.settings.includes("pg_settings"));
  assert.ok(checkup.METRICS_SQL.settings.includes("name"));
  assert.ok(checkup.METRICS_SQL.settings.includes("setting"));
});

test("METRICS_SQL.version queries server_version fields", () => {
  assert.ok(checkup.METRICS_SQL.version.includes("server_version"));
  assert.ok(checkup.METRICS_SQL.version.includes("server_version_num"));
});

// Mock client tests for report generators
function createMockClient(versionRows, settingsRows) {
  return {
    query: async (sql) => {
      if (sql.includes("server_version")) {
        return { rows: versionRows };
      }
      if (sql.includes("pg_settings") && sql.includes("ORDER BY")) {
        return { rows: settingsRows };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test("getPostgresVersion extracts version info from mock client", async () => {
  const mockClient = createMockClient([
    { name: "server_version", setting: "16.3" },
    { name: "server_version_num", setting: "160003" },
  ], []);

  const version = await checkup.getPostgresVersion(mockClient);
  assert.equal(version.version, "16.3");
  assert.equal(version.server_version_num, "160003");
  assert.equal(version.server_major_ver, "16");
  assert.equal(version.server_minor_ver, "3");
});

test("getSettings transforms rows to keyed object", async () => {
  const mockClient = createMockClient([], [
    {
      name: "shared_buffers",
      setting: "16384",
      unit: "8kB",
      category: "Resource Usage / Memory",
      context: "postmaster",
      vartype: "integer",
      pretty_value: "128 MB",
    },
    {
      name: "work_mem",
      setting: "4096",
      unit: "kB",
      category: "Resource Usage / Memory",
      context: "user",
      vartype: "integer",
      pretty_value: "4 MB",
    },
  ]);

  const settings = await checkup.getSettings(mockClient);
  assert.ok("shared_buffers" in settings);
  assert.ok("work_mem" in settings);
  assert.equal(settings.shared_buffers.setting, "16384");
  assert.equal(settings.shared_buffers.unit, "8kB");
  assert.equal(settings.work_mem.pretty_value, "4 MB");
});

test("generateA002 creates report with version data", async () => {
  const mockClient = createMockClient([
    { name: "server_version", setting: "16.3" },
    { name: "server_version_num", setting: "160003" },
  ], []);

  const report = await checkup.generateA002(mockClient, "test-node");
  assert.equal(report.checkId, "A002");
  assert.equal(report.checkTitle, "Postgres major version");
  assert.equal(report.nodes.primary, "test-node");
  assert.ok("test-node" in report.results);
  assert.ok("version" in report.results["test-node"].data);
  assert.equal(report.results["test-node"].data.version.version, "16.3");
});

test("generateA003 creates report with settings and version", async () => {
  const mockClient = createMockClient(
    [
      { name: "server_version", setting: "16.3" },
      { name: "server_version_num", setting: "160003" },
    ],
    [
      {
        name: "shared_buffers",
        setting: "16384",
        unit: "8kB",
        category: "Resource Usage / Memory",
        context: "postmaster",
        vartype: "integer",
        pretty_value: "128 MB",
      },
    ]
  );

  const report = await checkup.generateA003(mockClient, "test-node");
  assert.equal(report.checkId, "A003");
  assert.equal(report.checkTitle, "Postgres settings");
  assert.ok("test-node" in report.results);
  assert.ok("shared_buffers" in report.results["test-node"].data);
  assert.ok(report.results["test-node"].postgres_version);
  assert.equal(report.results["test-node"].postgres_version.version, "16.3");
});

test("generateA013 creates report with minor version data", async () => {
  const mockClient = createMockClient([
    { name: "server_version", setting: "16.3" },
    { name: "server_version_num", setting: "160003" },
  ], []);

  const report = await checkup.generateA013(mockClient, "test-node");
  assert.equal(report.checkId, "A013");
  assert.equal(report.checkTitle, "Postgres minor version");
  assert.equal(report.nodes.primary, "test-node");
  assert.ok("test-node" in report.results);
  assert.ok("version" in report.results["test-node"].data);
  assert.equal(report.results["test-node"].data.version.server_minor_ver, "3");
});

test("generateAllReports returns reports for all checks", async () => {
  const mockClient = createMockClient(
    [
      { name: "server_version", setting: "16.3" },
      { name: "server_version_num", setting: "160003" },
    ],
    [
      {
        name: "shared_buffers",
        setting: "16384",
        unit: "8kB",
        category: "Resource Usage / Memory",
        context: "postmaster",
        vartype: "integer",
        pretty_value: "128 MB",
      },
    ]
  );

  const reports = await checkup.generateAllReports(mockClient, "test-node");
  assert.ok("A002" in reports);
  assert.ok("A003" in reports);
  assert.ok("A013" in reports);
  assert.equal(reports.A002.checkId, "A002");
  assert.equal(reports.A003.checkId, "A003");
  assert.equal(reports.A013.checkId, "A013");
});

// CLI tests
test("cli: checkup command exists and shows help", () => {
  const r = runCli(["checkup", "--help"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /express mode/i);
  assert.match(r.stdout, /--check-id/);
  assert.match(r.stdout, /--node-name/);
  assert.match(r.stdout, /--output/);
  assert.match(r.stdout, /--json/);
});

test("cli: checkup --help shows available check IDs", () => {
  const r = runCli(["checkup", "--help"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /A002/);
  assert.match(r.stdout, /A003/);
  assert.match(r.stdout, /A013/);
});

test("cli: checkup without connection shows error", () => {
  const r = runCli(["checkup"]);
  assert.notEqual(r.status, 0);
  // Should show connection required error
  assert.match(r.stderr, /connection|required|PostgreSQL/i);
});
