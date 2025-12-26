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
  assert.ok(typeof report.version === "string" && report.version.length > 0);
  assert.ok(typeof report.build_ts === "string" && report.build_ts.length > 0);
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

test("CHECK_INFO contains A004", () => {
  assert.ok("A004" in checkup.CHECK_INFO);
  assert.equal(checkup.CHECK_INFO.A004, "Cluster information");
});

test("CHECK_INFO contains A007", () => {
  assert.ok("A007" in checkup.CHECK_INFO);
  assert.equal(checkup.CHECK_INFO.A007, "Altered settings");
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

test("REPORT_GENERATORS has generator for A004", () => {
  assert.ok("A004" in checkup.REPORT_GENERATORS);
  assert.equal(typeof checkup.REPORT_GENERATORS.A004, "function");
});

test("REPORT_GENERATORS has generator for A007", () => {
  assert.ok("A007" in checkup.REPORT_GENERATORS);
  assert.equal(typeof checkup.REPORT_GENERATORS.A007, "function");
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

test("METRICS_SQL.alteredSettings filters non-default settings", () => {
  assert.ok(checkup.METRICS_SQL.alteredSettings.includes("pg_settings"));
  assert.ok(checkup.METRICS_SQL.alteredSettings.includes("source <> 'default'"));
});

test("METRICS_SQL.databaseSizes queries pg_database", () => {
  assert.ok(checkup.METRICS_SQL.databaseSizes.includes("pg_database"));
  assert.ok(checkup.METRICS_SQL.databaseSizes.includes("pg_database_size"));
});

test("METRICS_SQL.clusterStats queries pg_stat_database", () => {
  assert.ok(checkup.METRICS_SQL.clusterStats.includes("pg_stat_database"));
  assert.ok(checkup.METRICS_SQL.clusterStats.includes("xact_commit"));
  assert.ok(checkup.METRICS_SQL.clusterStats.includes("deadlocks"));
});

test("METRICS_SQL.connectionStates queries pg_stat_activity", () => {
  assert.ok(checkup.METRICS_SQL.connectionStates.includes("pg_stat_activity"));
  assert.ok(checkup.METRICS_SQL.connectionStates.includes("state"));
});

// Tests for formatBytes
test("formatBytes formats zero bytes", () => {
  assert.equal(checkup.formatBytes(0), "0 B");
});

test("formatBytes formats bytes", () => {
  assert.equal(checkup.formatBytes(500), "500.00 B");
});

test("formatBytes formats kilobytes", () => {
  assert.equal(checkup.formatBytes(1024), "1.00 kB");
  assert.equal(checkup.formatBytes(1536), "1.50 kB");
});

test("formatBytes formats megabytes", () => {
  assert.equal(checkup.formatBytes(1048576), "1.00 MB");
});

test("formatBytes formats gigabytes", () => {
  assert.equal(checkup.formatBytes(1073741824), "1.00 GB");
});

// Mock client tests for report generators
function createMockClient(versionRows, settingsRows, options = {}) {
  const {
    alteredSettingsRows = [],
    databaseSizesRows = [],
    clusterStatsRows = [],
    connectionStatesRows = [],
    uptimeRows = [],
  } = options;

  return {
    query: async (sql) => {
      // Version query (used by many reports)
      if (sql.includes("server_version") && sql.includes("server_version_num") && !sql.includes("ORDER BY")) {
        return { rows: versionRows };
      }
      // Full settings query (A003) - check this BEFORE altered settings
      // because full settings has "ORDER BY" and "CASE WHEN source <> 'default'"
      // while altered settings has "WHERE source <> 'default'"
      if (sql.includes("pg_settings") && sql.includes("ORDER BY") && sql.includes("is_default")) {
        return { rows: settingsRows };
      }
      // Altered settings query (A007) - has "WHERE source <> 'default'" (not in a CASE)
      if (sql.includes("pg_settings") && sql.includes("WHERE source <> 'default'")) {
        return { rows: alteredSettingsRows };
      }
      // Database sizes (A004)
      if (sql.includes("pg_database") && sql.includes("pg_database_size")) {
        return { rows: databaseSizesRows };
      }
      // Cluster stats (A004)
      if (sql.includes("pg_stat_database") && sql.includes("xact_commit")) {
        return { rows: clusterStatsRows };
      }
      // Connection states (A004)
      if (sql.includes("pg_stat_activity") && sql.includes("state")) {
        return { rows: connectionStatesRows };
      }
      // Uptime info (A004)
      if (sql.includes("pg_postmaster_start_time")) {
        return { rows: uptimeRows };
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
    ],
    {
      alteredSettingsRows: [
        { name: "shared_buffers", setting: "16384", unit: "8kB", category: "Resource Usage / Memory", pretty_value: "128 MB" },
      ],
      databaseSizesRows: [{ datname: "postgres", size_bytes: "1073741824" }],
      clusterStatsRows: [{ total_connections: 5, total_commits: 100, total_rollbacks: 1, blocks_read: 1000, blocks_hit: 9000, tuples_returned: 500, tuples_fetched: 400, tuples_inserted: 50, tuples_updated: 30, tuples_deleted: 10, total_deadlocks: 0, temp_files_created: 0, temp_bytes_written: 0 }],
      connectionStatesRows: [{ state: "active", count: 2 }, { state: "idle", count: 3 }],
      uptimeRows: [{ start_time: new Date("2024-01-01T00:00:00Z"), uptime: "10 days" }],
    }
  );

  const reports = await checkup.generateAllReports(mockClient, "test-node");
  assert.ok("A002" in reports);
  assert.ok("A003" in reports);
  assert.ok("A004" in reports);
  assert.ok("A007" in reports);
  assert.ok("A013" in reports);
  assert.equal(reports.A002.checkId, "A002");
  assert.equal(reports.A003.checkId, "A003");
  assert.equal(reports.A004.checkId, "A004");
  assert.equal(reports.A007.checkId, "A007");
  assert.equal(reports.A013.checkId, "A013");
});

// Tests for A007 (Altered settings)
test("getAlteredSettings returns non-default settings", async () => {
  const mockClient = createMockClient([], [], {
    alteredSettingsRows: [
      { name: "shared_buffers", setting: "256MB", unit: "", category: "Resource Usage / Memory", pretty_value: "256 MB" },
      { name: "work_mem", setting: "64MB", unit: "", category: "Resource Usage / Memory", pretty_value: "64 MB" },
    ],
  });

  const settings = await checkup.getAlteredSettings(mockClient);
  assert.ok("shared_buffers" in settings);
  assert.ok("work_mem" in settings);
  assert.equal(settings.shared_buffers.value, "256MB");
  assert.equal(settings.work_mem.pretty_value, "64 MB");
});

test("generateA007 creates report with altered settings", async () => {
  const mockClient = createMockClient(
    [
      { name: "server_version", setting: "16.3" },
      { name: "server_version_num", setting: "160003" },
    ],
    [],
    {
      alteredSettingsRows: [
        { name: "max_connections", setting: "200", unit: "", category: "Connections and Authentication", pretty_value: "200" },
      ],
    }
  );

  const report = await checkup.generateA007(mockClient, "test-node");
  assert.equal(report.checkId, "A007");
  assert.equal(report.checkTitle, "Altered settings");
  assert.equal(report.nodes.primary, "test-node");
  assert.ok("test-node" in report.results);
  assert.ok("max_connections" in report.results["test-node"].data);
  assert.equal(report.results["test-node"].data.max_connections.value, "200");
  assert.ok(report.results["test-node"].postgres_version);
});

// Tests for A004 (Cluster information)
test("getDatabaseSizes returns database sizes", async () => {
  const mockClient = createMockClient([], [], {
    databaseSizesRows: [
      { datname: "postgres", size_bytes: "1073741824" },
      { datname: "mydb", size_bytes: "536870912" },
    ],
  });

  const sizes = await checkup.getDatabaseSizes(mockClient);
  assert.ok("postgres" in sizes);
  assert.ok("mydb" in sizes);
  assert.equal(sizes.postgres, 1073741824);
  assert.equal(sizes.mydb, 536870912);
});

test("getClusterInfo returns cluster metrics", async () => {
  const mockClient = createMockClient([], [], {
    clusterStatsRows: [{
      total_connections: 10,
      total_commits: 1000,
      total_rollbacks: 5,
      blocks_read: 500,
      blocks_hit: 9500,
      tuples_returned: 5000,
      tuples_fetched: 4000,
      tuples_inserted: 100,
      tuples_updated: 50,
      tuples_deleted: 25,
      total_deadlocks: 0,
      temp_files_created: 2,
      temp_bytes_written: 1048576,
    }],
    connectionStatesRows: [
      { state: "active", count: 3 },
      { state: "idle", count: 7 },
    ],
    uptimeRows: [{
      start_time: new Date("2024-01-01T00:00:00Z"),
      uptime: "30 days",
    }],
  });

  const info = await checkup.getClusterInfo(mockClient);
  assert.ok("total_connections" in info);
  assert.ok("cache_hit_ratio" in info);
  assert.ok("connections_active" in info);
  assert.ok("connections_idle" in info);
  assert.ok("start_time" in info);
  assert.equal(info.total_connections.value, "10");
  assert.equal(info.cache_hit_ratio.value, "95.00");
  assert.equal(info.connections_active.value, "3");
});

test("generateA004 creates report with cluster info and database sizes", async () => {
  const mockClient = createMockClient(
    [
      { name: "server_version", setting: "16.3" },
      { name: "server_version_num", setting: "160003" },
    ],
    [],
    {
      databaseSizesRows: [
        { datname: "postgres", size_bytes: "1073741824" },
      ],
      clusterStatsRows: [{
        total_connections: 5,
        total_commits: 100,
        total_rollbacks: 1,
        blocks_read: 100,
        blocks_hit: 900,
        tuples_returned: 500,
        tuples_fetched: 400,
        tuples_inserted: 50,
        tuples_updated: 30,
        tuples_deleted: 10,
        total_deadlocks: 0,
        temp_files_created: 0,
        temp_bytes_written: 0,
      }],
      connectionStatesRows: [{ state: "active", count: 2 }],
      uptimeRows: [{ start_time: new Date("2024-01-01T00:00:00Z"), uptime: "10 days" }],
    }
  );

  const report = await checkup.generateA004(mockClient, "test-node");
  assert.equal(report.checkId, "A004");
  assert.equal(report.checkTitle, "Cluster information");
  assert.equal(report.nodes.primary, "test-node");
  assert.ok("test-node" in report.results);

  const data = report.results["test-node"].data;
  assert.ok("general_info" in data);
  assert.ok("database_sizes" in data);
  assert.ok("total_connections" in data.general_info);
  assert.ok("postgres" in data.database_sizes);
  assert.equal(data.database_sizes.postgres, 1073741824);
  assert.ok(report.results["test-node"].postgres_version);
});

// CLI tests
test("cli: checkup command exists and shows help", () => {
  const r = runCli(["checkup", "--help"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /express mode/i);
  assert.match(r.stdout, /--check-id/);
  assert.match(r.stdout, /--node-name/);
  assert.match(r.stdout, /--output/);
  assert.match(r.stdout, /upload/);
  assert.match(r.stdout, /--json/);
});

test("cli: checkup --help shows available check IDs", () => {
  const r = runCli(["checkup", "--help"]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /A002/);
  assert.match(r.stdout, /A003/);
  assert.match(r.stdout, /A004/);
  assert.match(r.stdout, /A007/);
  assert.match(r.stdout, /A013/);
});

test("cli: checkup without connection shows help", () => {
  const r = runCli(["checkup"]);
  assert.notEqual(r.status, 0);
  // Should show full help (options + examples), like `checkup --help`
  assert.match(r.stdout, /generate health check reports/i);
  assert.match(r.stdout, /--check-id/);
  assert.match(r.stdout, /available checks/i);
  assert.match(r.stdout, /A002/);
});

test("cli: set-default-project writes config defaultProject", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  const tmpRoot = path.resolve(__dirname, ".tmp-config");
  const xdgHome = path.join(tmpRoot, "xdg");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(xdgHome, { recursive: true });

  const r = runCli(["set-default-project", "cli_project"], { XDG_CONFIG_HOME: xdgHome });
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const cfgPath = path.join(xdgHome, "postgresai", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(cfg.defaultProject, "cli_project");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("cli: checkup --output validates/creates output dir before connecting", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  const tmpRoot = path.resolve(__dirname, ".tmp-output");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  // Make parent dir non-writable and attempt to create a child output dir inside it.
  const locked = path.join(tmpRoot, "locked");
  fs.mkdirSync(locked, { recursive: true });
  fs.chmodSync(locked, 0o555);

  const out = path.join(locked, "reports");
  const r = runCli(["checkup", "postgresql://user:pass@127.0.0.1:1/db", "--output", out]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /failed to create output directory/i);

  // Cleanup: restore perms so we can delete it.
  fs.chmodSync(locked, 0o755);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("cli: checkup defaults to upload and requires API key (fast-fail)", () => {
  const r = runCli(["checkup", "postgresql://user:pass@127.0.0.1:1/db"], {
    PGAI_API_KEY: "",
    XDG_CONFIG_HOME: "/nonexistent",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /api key is required/i);
});

test("cli: checkup defaults to upload and uses defaultProject when --project omitted", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  const tmpRoot = path.resolve(__dirname, ".tmp-config2");
  const xdgHome = path.join(tmpRoot, "xdg");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(xdgHome, "postgresai"), { recursive: true });

  // Provide API key + defaultProject so preflight passes without --project.
  fs.writeFileSync(
    path.join(xdgHome, "postgresai", "config.json"),
    JSON.stringify({ apiKey: "dummy", defaultProject: "p" }, null, 2) + "\n"
  );

  // It will fail later on connection (port 1) — that's fine; we only assert it didn't
  // fail due to missing project/API key.
  const r = runCli(["checkup", "postgresql://user:pass@127.0.0.1:1/db"], { XDG_CONFIG_HOME: xdgHome });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /--project is required/i);
  assert.doesNotMatch(r.stderr, /api key is required/i);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("cli: checkup generates and saves defaultProject when missing", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  const tmpRoot = path.resolve(__dirname, ".tmp-config3");
  const xdgHome = path.join(tmpRoot, "xdg");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(xdgHome, { recursive: true });

  // Provide API key via env so upload preflight passes without any config file.
  const r = runCli(["checkup", "postgresql://user:pass@127.0.0.1:1/db"], {
    XDG_CONFIG_HOME: xdgHome,
    PGAI_API_KEY: "dummy",
  });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /--project is required/i);
  assert.doesNotMatch(r.stderr, /api key is required/i);

  const cfgPath = path.join(xdgHome, "postgresai", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(typeof cfg.defaultProject, "string");
  assert.match(cfg.defaultProject, /^project_[0-9a-f]+$/);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("formatRpcErrorForDisplay formats details/hint nicely", () => {
  const api = require("../dist/lib/checkup-api.js");
  const err = new api.RpcError({
    rpcName: "checkup_report_file_post",
    statusCode: 402,
    payloadText: JSON.stringify({
      hint: "Start an express checkup subscription for the organization or contact support.",
      details: "Checkup report uploads require an active checkup subscription",
    }),
    payloadJson: {
      hint: "Start an express checkup subscription for the organization or contact support.",
      details: "Checkup report uploads require an active checkup subscription.",
    },
  });
  const lines = api.formatRpcErrorForDisplay(err);
  const text = lines.join("\n");
  assert.match(text, /RPC checkup_report_file_post failed: HTTP 402/);
  assert.match(text, /Details:/);
  assert.match(text, /Hint:/);
});
