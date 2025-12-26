import { describe, test, expect } from "bun:test";
import { resolve } from "path";

// Import from source directly since we're using Bun
import * as checkup from "../lib/checkup";
import * as api from "../lib/checkup-api";


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

// Mock client for testing report generators
interface MockClientOptions {
  alteredSettingsRows?: any[];
  databaseSizesRows?: any[];
  clusterStatsRows?: any[];
  connectionStatesRows?: any[];
  uptimeRows?: any[];
  invalidIndexesRows?: any[];
  unusedIndexesRows?: any[];
  redundantIndexesRows?: any[];
}

function createMockClient(versionRows: any[], settingsRows: any[], options: MockClientOptions = {}) {
  const {
    alteredSettingsRows = [],
    databaseSizesRows = [],
    clusterStatsRows = [],
    connectionStatesRows = [],
    uptimeRows = [],
    invalidIndexesRows = [],
    unusedIndexesRows = [],
    redundantIndexesRows = [],
  } = options;

  return {
    query: async (sql: string) => {
      // Version query (used by many reports)
      if (sql.includes("server_version") && sql.includes("server_version_num") && !sql.includes("order by")) {
        return { rows: versionRows };
      }
      // Full settings query (A003)
      if (sql.includes("pg_settings") && sql.includes("order by") && sql.includes("is_default")) {
        return { rows: settingsRows };
      }
      // Altered settings query (A007)
      if (sql.includes("pg_settings") && sql.includes("where source <> 'default'")) {
        return { rows: alteredSettingsRows };
      }
      // Database sizes (A004)
      if (sql.includes("pg_database") && sql.includes("pg_database_size") && !sql.includes("current_database")) {
        return { rows: databaseSizesRows };
      }
      // Current database info (H001, H002, H004)
      if (sql.includes("current_database()") && sql.includes("pg_database_size")) {
        return { rows: [{ datname: "testdb", size_bytes: "1073741824" }] };
      }
      // Stats reset info (H002)
      if (sql.includes("stats_reset") && sql.includes("pg_stat_database")) {
        return { rows: [{ 
          stats_reset_epoch: "1704067200", 
          stats_reset_time: "2024-01-01 00:00:00+00",
          days_since_reset: "30",
          postmaster_startup_epoch: "1704067200",
          postmaster_startup_time: "2024-01-01 00:00:00+00"
        }] };
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
      // Invalid indexes (H001)
      if (sql.includes("indisvalid = false")) {
        return { rows: invalidIndexesRows };
      }
      // Unused indexes (H002)
      if (sql.includes("Never Used Indexes") && sql.includes("idx_scan = 0")) {
        return { rows: unusedIndexesRows };
      }
      // Redundant indexes (H004)
      if (sql.includes("redundant_indexes") && sql.includes("columns like")) {
        return { rows: redundantIndexesRows };
      }
      // D004: pg_stat_statements extension check
      if (sql.includes("pg_extension") && sql.includes("pg_stat_statements")) {
        return { rows: [] }; // Extension not installed by default
      }
      // D004: pg_stat_kcache extension check
      if (sql.includes("pg_extension") && sql.includes("pg_stat_kcache")) {
        return { rows: [] }; // Extension not installed by default
      }
      // G001: Memory settings query
      if (sql.includes("pg_size_bytes") && sql.includes("shared_buffers") && sql.includes("work_mem")) {
        return { rows: [{
          shared_buffers_bytes: "134217728",
          wal_buffers_bytes: "4194304",
          work_mem_bytes: "4194304",
          maintenance_work_mem_bytes: "67108864",
          effective_cache_size_bytes: "4294967296",
          max_connections: 100,
        }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

// Unit tests for parseVersionNum
describe("parseVersionNum", () => {
  test("parses PG 16.3 version number", () => {
    const result = checkup.parseVersionNum("160003");
    expect(result.major).toBe("16");
    expect(result.minor).toBe("3");
  });

  test("parses PG 15.7 version number", () => {
    const result = checkup.parseVersionNum("150007");
    expect(result.major).toBe("15");
    expect(result.minor).toBe("7");
  });

  test("parses PG 14.12 version number", () => {
    const result = checkup.parseVersionNum("140012");
    expect(result.major).toBe("14");
    expect(result.minor).toBe("12");
  });

  test("handles empty string", () => {
    const result = checkup.parseVersionNum("");
    expect(result.major).toBe("");
    expect(result.minor).toBe("");
  });

  test("handles null/undefined", () => {
    const result = checkup.parseVersionNum(null as any);
    expect(result.major).toBe("");
    expect(result.minor).toBe("");
  });

  test("handles short string", () => {
    const result = checkup.parseVersionNum("123");
    expect(result.major).toBe("");
    expect(result.minor).toBe("");
  });
});

// Unit tests for createBaseReport
describe("createBaseReport", () => {
  test("creates correct structure", () => {
    const report = checkup.createBaseReport("A002", "Postgres major version", "test-node");

    expect(report.checkId).toBe("A002");
    expect(report.checkTitle).toBe("Postgres major version");
    expect(typeof report.version).toBe("string");
    expect(report.version!.length).toBeGreaterThan(0);
    expect(typeof report.build_ts).toBe("string");
    expect(report.nodes.primary).toBe("test-node");
    expect(report.nodes.standbys).toEqual([]);
    expect(report.results).toEqual({});
    expect(typeof report.timestamptz).toBe("string");
    // Verify timestamp is ISO format
    expect(new Date(report.timestamptz).toISOString()).toBe(report.timestamptz);
  });

  test("uses provided node name", () => {
    const report = checkup.createBaseReport("A003", "Postgres settings", "my-custom-node");
    expect(report.nodes.primary).toBe("my-custom-node");
  });
});

// Tests for CHECK_INFO
describe("CHECK_INFO", () => {
  test("contains A002", () => {
    expect("A002" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.A002).toBe("Postgres major version");
  });

  test("contains A003", () => {
    expect("A003" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.A003).toBe("Postgres settings");
  });

  test("contains A013", () => {
    expect("A013" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.A013).toBe("Postgres minor version");
  });

  test("contains A004", () => {
    expect("A004" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.A004).toBe("Cluster information");
  });

  test("contains A007", () => {
    expect("A007" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.A007).toBe("Altered settings");
  });

  test("contains H001", () => {
    expect("H001" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.H001).toBe("Invalid indexes");
  });

  test("contains H002", () => {
    expect("H002" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.H002).toBe("Unused indexes");
  });

  test("contains H004", () => {
    expect("H004" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.H004).toBe("Redundant indexes");
  });

  test("contains D004", () => {
    expect("D004" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.D004).toBe("pg_stat_statements and pg_stat_kcache settings");
  });

  test("contains F001", () => {
    expect("F001" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.F001).toBe("Autovacuum: current settings");
  });

  test("contains G001", () => {
    expect("G001" in checkup.CHECK_INFO).toBe(true);
    expect(checkup.CHECK_INFO.G001).toBe("Memory-related settings");
  });
});

// Tests for REPORT_GENERATORS
describe("REPORT_GENERATORS", () => {
  test("has generator for A002", () => {
    expect("A002" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.A002).toBe("function");
  });

  test("has generator for A003", () => {
    expect("A003" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.A003).toBe("function");
  });

  test("has generator for A013", () => {
    expect("A013" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.A013).toBe("function");
  });

  test("has generator for A004", () => {
    expect("A004" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.A004).toBe("function");
  });

  test("has generator for A007", () => {
    expect("A007" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.A007).toBe("function");
  });

  test("has generator for H001", () => {
    expect("H001" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.H001).toBe("function");
  });

  test("has generator for H002", () => {
    expect("H002" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.H002).toBe("function");
  });

  test("has generator for H004", () => {
    expect("H004" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.H004).toBe("function");
  });

  test("has generator for D004", () => {
    expect("D004" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.D004).toBe("function");
  });

  test("has generator for F001", () => {
    expect("F001" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.F001).toBe("function");
  });

  test("has generator for G001", () => {
    expect("G001" in checkup.REPORT_GENERATORS).toBe(true);
    expect(typeof checkup.REPORT_GENERATORS.G001).toBe("function");
  });

  test("REPORT_GENERATORS and CHECK_INFO have same keys", () => {
    const generatorKeys = Object.keys(checkup.REPORT_GENERATORS).sort();
    const infoKeys = Object.keys(checkup.CHECK_INFO).sort();
    expect(generatorKeys).toEqual(infoKeys);
  });
});

// Tests for formatBytes
describe("formatBytes", () => {
  test("formats zero bytes", () => {
    expect(checkup.formatBytes(0)).toBe("0 B");
  });

  test("formats bytes", () => {
    expect(checkup.formatBytes(500)).toBe("500.00 B");
  });

  test("formats kibibytes", () => {
    expect(checkup.formatBytes(1024)).toBe("1.00 KiB");
    expect(checkup.formatBytes(1536)).toBe("1.50 KiB");
  });

  test("formats mebibytes", () => {
    expect(checkup.formatBytes(1048576)).toBe("1.00 MiB");
  });

  test("formats gibibytes", () => {
    expect(checkup.formatBytes(1073741824)).toBe("1.00 GiB");
  });
});

// Mock client tests for report generators
describe("Report generators with mock client", () => {
  test("getPostgresVersion extracts version info", async () => {
    const mockClient = createMockClient([
      { name: "server_version", setting: "16.3" },
      { name: "server_version_num", setting: "160003" },
    ], []);

    const version = await checkup.getPostgresVersion(mockClient as any);
    expect(version.version).toBe("16.3");
    expect(version.server_version_num).toBe("160003");
    expect(version.server_major_ver).toBe("16");
    expect(version.server_minor_ver).toBe("3");
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

    const settings = await checkup.getSettings(mockClient as any);
    expect("shared_buffers" in settings).toBe(true);
    expect("work_mem" in settings).toBe(true);
    expect(settings.shared_buffers.setting).toBe("16384");
    expect(settings.shared_buffers.unit).toBe("8kB");
    expect(settings.work_mem.pretty_value).toBe("4 MB");
  });

  test("generateA002 creates report with version data", async () => {
    const mockClient = createMockClient([
      { name: "server_version", setting: "16.3" },
      { name: "server_version_num", setting: "160003" },
    ], []);

    const report = await checkup.generateA002(mockClient as any, "test-node");
    expect(report.checkId).toBe("A002");
    expect(report.checkTitle).toBe("Postgres major version");
    expect(report.nodes.primary).toBe("test-node");
    expect("test-node" in report.results).toBe(true);
    expect("version" in report.results["test-node"].data).toBe(true);
    expect(report.results["test-node"].data.version.version).toBe("16.3");
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

    const report = await checkup.generateA003(mockClient as any, "test-node");
    expect(report.checkId).toBe("A003");
    expect(report.checkTitle).toBe("Postgres settings");
    expect("test-node" in report.results).toBe(true);
    expect("shared_buffers" in report.results["test-node"].data).toBe(true);
    expect(report.results["test-node"].postgres_version).toBeTruthy();
    expect(report.results["test-node"].postgres_version!.version).toBe("16.3");
  });

  test("generateA013 creates report with minor version data", async () => {
    const mockClient = createMockClient([
      { name: "server_version", setting: "16.3" },
      { name: "server_version_num", setting: "160003" },
    ], []);

    const report = await checkup.generateA013(mockClient as any, "test-node");
    expect(report.checkId).toBe("A013");
    expect(report.checkTitle).toBe("Postgres minor version");
    expect(report.nodes.primary).toBe("test-node");
    expect("test-node" in report.results).toBe(true);
    expect("version" in report.results["test-node"].data).toBe(true);
    expect(report.results["test-node"].data.version.server_minor_ver).toBe("3");
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
        invalidIndexesRows: [],
        unusedIndexesRows: [],
        redundantIndexesRows: [],
      }
    );

    const reports = await checkup.generateAllReports(mockClient as any, "test-node");
    expect("A002" in reports).toBe(true);
    expect("A003" in reports).toBe(true);
    expect("A004" in reports).toBe(true);
    expect("A007" in reports).toBe(true);
    expect("A013" in reports).toBe(true);
    expect("H001" in reports).toBe(true);
    expect("H002" in reports).toBe(true);
    expect("H004" in reports).toBe(true);
    expect(reports.A002.checkId).toBe("A002");
    expect(reports.A003.checkId).toBe("A003");
    expect(reports.A004.checkId).toBe("A004");
    expect(reports.A007.checkId).toBe("A007");
    expect(reports.A013.checkId).toBe("A013");
    expect(reports.H001.checkId).toBe("H001");
    expect(reports.H002.checkId).toBe("H002");
    expect(reports.H004.checkId).toBe("H004");
  });
});

// Tests for A007 (Altered settings)
describe("A007 - Altered settings", () => {
  test("getAlteredSettings returns non-default settings", async () => {
    const mockClient = createMockClient([], [], {
      alteredSettingsRows: [
        { name: "shared_buffers", setting: "256MB", unit: "", category: "Resource Usage / Memory", pretty_value: "256 MB" },
        { name: "work_mem", setting: "64MB", unit: "", category: "Resource Usage / Memory", pretty_value: "64 MB" },
      ],
    });

    const settings = await checkup.getAlteredSettings(mockClient as any);
    expect("shared_buffers" in settings).toBe(true);
    expect("work_mem" in settings).toBe(true);
    expect(settings.shared_buffers.value).toBe("256MB");
    expect(settings.work_mem.pretty_value).toBe("64 MB");
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

    const report = await checkup.generateA007(mockClient as any, "test-node");
    expect(report.checkId).toBe("A007");
    expect(report.checkTitle).toBe("Altered settings");
    expect(report.nodes.primary).toBe("test-node");
    expect("test-node" in report.results).toBe(true);
    expect("max_connections" in report.results["test-node"].data).toBe(true);
    expect(report.results["test-node"].data.max_connections.value).toBe("200");
    expect(report.results["test-node"].postgres_version).toBeTruthy();
  });
});

// Tests for A004 (Cluster information)
describe("A004 - Cluster information", () => {
  test("getDatabaseSizes returns database sizes", async () => {
    const mockClient = createMockClient([], [], {
      databaseSizesRows: [
        { datname: "postgres", size_bytes: "1073741824" },
        { datname: "mydb", size_bytes: "536870912" },
      ],
    });

    const sizes = await checkup.getDatabaseSizes(mockClient as any);
    expect("postgres" in sizes).toBe(true);
    expect("mydb" in sizes).toBe(true);
    expect(sizes.postgres).toBe(1073741824);
    expect(sizes.mydb).toBe(536870912);
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

    const info = await checkup.getClusterInfo(mockClient as any);
    expect("total_connections" in info).toBe(true);
    expect("cache_hit_ratio" in info).toBe(true);
    expect("connections_active" in info).toBe(true);
    expect("connections_idle" in info).toBe(true);
    expect("start_time" in info).toBe(true);
    expect(info.total_connections.value).toBe("10");
    expect(info.cache_hit_ratio.value).toBe("95.00");
    expect(info.connections_active.value).toBe("3");
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

    const report = await checkup.generateA004(mockClient as any, "test-node");
    expect(report.checkId).toBe("A004");
    expect(report.checkTitle).toBe("Cluster information");
    expect(report.nodes.primary).toBe("test-node");
    expect("test-node" in report.results).toBe(true);

    const data = report.results["test-node"].data;
    expect("general_info" in data).toBe(true);
    expect("database_sizes" in data).toBe(true);
    expect("total_connections" in data.general_info).toBe(true);
    expect("postgres" in data.database_sizes).toBe(true);
    expect(data.database_sizes.postgres).toBe(1073741824);
    expect(report.results["test-node"].postgres_version).toBeTruthy();
  });
});

// Tests for H001 (Invalid indexes)
describe("H001 - Invalid indexes", () => {
  test("getInvalidIndexes returns invalid indexes", async () => {
    const mockClient = createMockClient([], [], {
      invalidIndexesRows: [
        { schema_name: "public", table_name: "users", index_name: "users_email_idx", relation_name: "users", index_size_bytes: "1048576", supports_fk: false },
      ],
    });

    const indexes = await checkup.getInvalidIndexes(mockClient as any);
    expect(indexes.length).toBe(1);
    expect(indexes[0].schema_name).toBe("public");
    expect(indexes[0].table_name).toBe("users");
    expect(indexes[0].index_name).toBe("users_email_idx");
    expect(indexes[0].index_size_bytes).toBe(1048576);
    expect(indexes[0].index_size_pretty).toBeTruthy();
    expect(indexes[0].relation_name).toBe("users");
    expect(indexes[0].supports_fk).toBe(false);
  });

  test("generateH001 creates report with invalid indexes", async () => {
    const mockClient = createMockClient(
      [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
      [],
      {
        invalidIndexesRows: [
          { schema_name: "public", table_name: "orders", index_name: "orders_status_idx", relation_name: "orders", index_size_bytes: "2097152", supports_fk: false },
        ],
      }
    );

    const report = await checkup.generateH001(mockClient as any, "test-node");
    expect(report.checkId).toBe("H001");
    expect(report.checkTitle).toBe("Invalid indexes");
    expect("test-node" in report.results).toBe(true);

    // Data is now keyed by database name
    const data = report.results["test-node"].data;
    expect("testdb" in data).toBe(true);
    const dbData = data["testdb"] as any;
    expect(dbData.invalid_indexes).toBeTruthy();
    expect(dbData.total_count).toBe(1);
    expect(dbData.total_size_bytes).toBe(2097152);
    expect(dbData.total_size_pretty).toBeTruthy();
    expect(dbData.database_size_bytes).toBeTruthy();
    expect(dbData.database_size_pretty).toBeTruthy();
    expect(report.results["test-node"].postgres_version).toBeTruthy();
  });

  test("generateH001 has correct top-level structure", async () => {
    const mockClient = createMockClient(
      [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
      [],
      {
        invalidIndexesRows: [
          { schema_name: "public", table_name: "orders", index_name: "orders_status_idx", relation_name: "orders", index_size_bytes: "2097152", supports_fk: false },
        ],
      }
    );

    const report = await checkup.generateH001(mockClient as any, "test-node");
    
    // Verify top-level structure matches schema expectations
    expect(report.checkId).toBe("H001");
    expect(report.checkTitle).toBe("Invalid indexes");
    expect(typeof report.timestamptz).toBe("string");
    expect(report.nodes.primary).toBe("test-node");
    expect(Array.isArray(report.nodes.standbys)).toBe(true);
    expect("test-node" in report.results).toBe(true);
    expect(report.results["test-node"].postgres_version).toBeTruthy();
    // Data is now keyed by database name
    expect("testdb" in report.results["test-node"].data).toBe(true);
    expect((report.results["test-node"].data as any)["testdb"].invalid_indexes).toBeTruthy();
  });
});

// Tests for H002 (Unused indexes)
describe("H002 - Unused indexes", () => {
  test("getUnusedIndexes returns unused indexes", async () => {
    const mockClient = createMockClient([], [], {
      unusedIndexesRows: [
        {
          schema_name: "public",
          table_name: "products",
          index_name: "products_old_idx",
          index_definition: "CREATE INDEX products_old_idx ON public.products USING btree (old_column)",
          reason: "Never Used Indexes",
          index_size_bytes: "4194304",
          idx_scan: "0",
          idx_is_btree: true,
          supports_fk: false,
        },
      ],
    });

    const indexes = await checkup.getUnusedIndexes(mockClient as any);
    expect(indexes.length).toBe(1);
    expect(indexes[0].schema_name).toBe("public");
    expect(indexes[0].index_name).toBe("products_old_idx");
    expect(indexes[0].index_size_bytes).toBe(4194304);
    expect(indexes[0].idx_scan).toBe(0);
    expect(indexes[0].supports_fk).toBe(false);
    expect(indexes[0].index_definition).toBeTruthy();
    expect(indexes[0].idx_is_btree).toBe(true);
  });

  test("generateH002 creates report with unused indexes", async () => {
    const mockClient = createMockClient(
      [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
      [],
      {
        unusedIndexesRows: [
          {
            schema_name: "public",
            table_name: "logs",
            index_name: "logs_created_idx",
            index_definition: "CREATE INDEX logs_created_idx ON public.logs USING btree (created_at)",
            reason: "Never Used Indexes",
            index_size_bytes: "8388608",
            idx_scan: "0",
            idx_is_btree: true,
            supports_fk: false,
          },
        ],
      }
    );

    const report = await checkup.generateH002(mockClient as any, "test-node");
    expect(report.checkId).toBe("H002");
    expect(report.checkTitle).toBe("Unused indexes");
    expect("test-node" in report.results).toBe(true);

    // Data is now keyed by database name
    const data = report.results["test-node"].data;
    expect("testdb" in data).toBe(true);
    const dbData = data["testdb"] as any;
    expect(dbData.unused_indexes).toBeTruthy();
    expect(dbData.total_count).toBe(1);
    expect(dbData.total_size_bytes).toBe(8388608);
    expect(dbData.total_size_pretty).toBeTruthy();
    expect(dbData.stats_reset).toBeTruthy();
    expect(report.results["test-node"].postgres_version).toBeTruthy();
  });

  test("generateH002 has correct top-level structure", async () => {
    const mockClient = createMockClient(
      [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
      [],
      {
        unusedIndexesRows: [
          {
            schema_name: "public",
            table_name: "logs",
            index_name: "logs_created_idx",
            index_definition: "CREATE INDEX logs_created_idx ON public.logs USING btree (created_at)",
            reason: "Never Used Indexes",
            index_size_bytes: "8388608",
            idx_scan: "0",
            idx_is_btree: true,
            supports_fk: false,
          },
        ],
      }
    );

    const report = await checkup.generateH002(mockClient as any, "test-node");
    
    // Verify top-level structure matches schema expectations
    expect(report.checkId).toBe("H002");
    expect(report.checkTitle).toBe("Unused indexes");
    expect(typeof report.timestamptz).toBe("string");
    expect(report.nodes.primary).toBe("test-node");
    expect(Array.isArray(report.nodes.standbys)).toBe(true);
    expect("test-node" in report.results).toBe(true);
    expect(report.results["test-node"].postgres_version).toBeTruthy();
    // Data is now keyed by database name
    expect("testdb" in report.results["test-node"].data).toBe(true);
    expect((report.results["test-node"].data as any)["testdb"].unused_indexes).toBeTruthy();
  });
});

// Tests for H004 (Redundant indexes)
describe("H004 - Redundant indexes", () => {
  test("getRedundantIndexes returns redundant indexes", async () => {
    const mockClient = createMockClient([], [], {
      redundantIndexesRows: [
        {
          schema_name: "public",
          table_name: "orders",
          index_name: "orders_user_id_idx",
          relation_name: "orders",
          access_method: "btree",
          reason: "public.orders_user_id_created_idx",
          index_size_bytes: "2097152",
          table_size_bytes: "16777216",
          index_usage: "0",
          supports_fk: false,
          index_definition: "CREATE INDEX orders_user_id_idx ON public.orders USING btree (user_id)",
          redundant_to_json: JSON.stringify([
            { index_name: "public.orders_user_id_created_idx", index_definition: "CREATE INDEX orders_user_id_created_idx ON public.orders USING btree (user_id, created_at)" }
          ]),
        },
      ],
    });

    const indexes = await checkup.getRedundantIndexes(mockClient as any);
    expect(indexes.length).toBe(1);
    expect(indexes[0].schema_name).toBe("public");
    expect(indexes[0].index_name).toBe("orders_user_id_idx");
    expect(indexes[0].reason).toBe("public.orders_user_id_created_idx");
    expect(indexes[0].index_size_bytes).toBe(2097152);
    expect(indexes[0].supports_fk).toBe(false);
    expect(indexes[0].index_definition).toBeTruthy();
    expect(indexes[0].relation_name).toBe("orders");
    // Verify redundant_to is populated with definitions
    expect(indexes[0].redundant_to).toBeInstanceOf(Array);
    expect(indexes[0].redundant_to.length).toBe(1);
    expect(indexes[0].redundant_to[0].index_name).toBe("public.orders_user_id_created_idx");
    expect(indexes[0].redundant_to[0].index_definition).toContain("CREATE INDEX");
  });

  test("generateH004 creates report with redundant indexes", async () => {
    const mockClient = createMockClient(
      [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
      [],
      {
        redundantIndexesRows: [
          {
            schema_name: "public",
            table_name: "products",
            index_name: "products_category_idx",
            relation_name: "products",
            access_method: "btree",
            reason: "public.products_category_name_idx",
            index_size_bytes: "4194304",
            table_size_bytes: "33554432",
            index_usage: "5",
            supports_fk: false,
            index_definition: "CREATE INDEX products_category_idx ON public.products USING btree (category)",
            redundant_to_json: JSON.stringify([
              { index_name: "public.products_category_name_idx", index_definition: "CREATE INDEX products_category_name_idx ON public.products USING btree (category, name)" }
            ]),
          },
        ],
      }
    );

    const report = await checkup.generateH004(mockClient as any, "test-node");
    expect(report.checkId).toBe("H004");
    expect(report.checkTitle).toBe("Redundant indexes");
    expect("test-node" in report.results).toBe(true);

    // Data is now keyed by database name
    const data = report.results["test-node"].data;
    expect("testdb" in data).toBe(true);
    const dbData = data["testdb"] as any;
    expect(dbData.redundant_indexes).toBeTruthy();
    expect(dbData.total_count).toBe(1);
    expect(dbData.total_size_bytes).toBe(4194304);
    expect(dbData.total_size_pretty).toBeTruthy();
    expect(dbData.database_size_bytes).toBeTruthy();
    expect(report.results["test-node"].postgres_version).toBeTruthy();
  });

  test("generateH004 has correct top-level structure", async () => {
    const mockClient = createMockClient(
      [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
      [],
      {
        redundantIndexesRows: [
          {
            schema_name: "public",
            table_name: "products",
            index_name: "products_category_idx",
            relation_name: "products",
            access_method: "btree",
            reason: "public.products_category_name_idx",
            index_size_bytes: "4194304",
            table_size_bytes: "33554432",
            index_usage: "5",
            supports_fk: false,
            index_definition: "CREATE INDEX products_category_idx ON public.products USING btree (category)",
            redundant_to_json: JSON.stringify([
              { index_name: "public.products_category_name_idx", index_definition: "CREATE INDEX products_category_name_idx ON public.products USING btree (category, name)" }
            ]),
          },
        ],
      }
    );

    const report = await checkup.generateH004(mockClient as any, "test-node");
    
    // Verify top-level structure matches schema expectations
    expect(report.checkId).toBe("H004");
    expect(report.checkTitle).toBe("Redundant indexes");
    expect(typeof report.timestamptz).toBe("string");
    expect(report.nodes.primary).toBe("test-node");
    expect(Array.isArray(report.nodes.standbys)).toBe(true);
    expect("test-node" in report.results).toBe(true);
    expect(report.results["test-node"].postgres_version).toBeTruthy();
    // Data is now keyed by database name
    expect("testdb" in report.results["test-node"].data).toBe(true);
    expect((report.results["test-node"].data as any)["testdb"].redundant_indexes).toBeTruthy();
  });
});

// CLI tests
describe("CLI tests", () => {
  test("checkup command exists and shows help", () => {
    const r = runCli(["checkup", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/express mode/i);
    expect(r.stdout).toMatch(/--check-id/);
    expect(r.stdout).toMatch(/--node-name/);
    expect(r.stdout).toMatch(/--output/);
    expect(r.stdout).toMatch(/upload/);
    expect(r.stdout).toMatch(/--json/);
  });

  test("checkup --help shows available check IDs", () => {
    const r = runCli(["checkup", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/A002/);
    expect(r.stdout).toMatch(/A003/);
    expect(r.stdout).toMatch(/A004/);
    expect(r.stdout).toMatch(/A007/);
    expect(r.stdout).toMatch(/A013/);
    expect(r.stdout).toMatch(/H001/);
    expect(r.stdout).toMatch(/H002/);
    expect(r.stdout).toMatch(/H004/);
  });

  test("checkup without connection shows help", () => {
    const r = runCli(["checkup"]);
    expect(r.status).not.toBe(0);
    // Should show full help (options + examples), like `checkup --help`
    expect(r.stdout).toMatch(/generate health check reports/i);
    expect(r.stdout).toMatch(/--check-id/);
    expect(r.stdout).toMatch(/available checks/i);
    expect(r.stdout).toMatch(/A002/);
  });
});

// Tests for checkup-api module
describe("checkup-api", () => {
  test("formatRpcErrorForDisplay formats details/hint nicely", () => {
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
    expect(text).toMatch(/RPC checkup_report_file_post failed: HTTP 402/);
    expect(text).toMatch(/Details:/);
    expect(text).toMatch(/Hint:/);
  });
});

