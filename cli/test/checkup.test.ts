import { describe, test, expect } from "bun:test";
import { resolve } from "path";

// Import from source directly since we're using Bun
import * as checkup from "../lib/checkup";
import * as api from "../lib/checkup-api";
import { createMockClient } from "./test-utils";


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
describe("CHECK_INFO and REPORT_GENERATORS", () => {
  const expectedChecks: Record<string, string> = {
    A002: "Postgres major version",
    A003: "Postgres settings",
    A004: "Cluster information",
    A007: "Altered settings",
    A013: "Postgres minor version",
    D004: "pg_stat_statements and pg_stat_kcache settings",
    F001: "Autovacuum: current settings",
    G001: "Memory-related settings",
    H001: "Invalid indexes",
    H002: "Unused indexes",
    H004: "Redundant indexes",
  };

  test("CHECK_INFO contains all expected checks with correct descriptions", () => {
    for (const [checkId, description] of Object.entries(expectedChecks)) {
      expect(checkup.CHECK_INFO[checkId]).toBe(description);
    }
  });

  test("REPORT_GENERATORS has function for each check", () => {
    for (const checkId of Object.keys(expectedChecks)) {
      expect(typeof checkup.REPORT_GENERATORS[checkId]).toBe("function");
    }
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

  test("handles negative bytes", () => {
    expect(checkup.formatBytes(-1024)).toBe("-1.00 KiB");
    expect(checkup.formatBytes(-1048576)).toBe("-1.00 MiB");
  });

  test("handles edge cases", () => {
    expect(checkup.formatBytes(NaN)).toBe("NaN B");
    expect(checkup.formatBytes(Infinity)).toBe("Infinity B");
  });
});

// Mock client tests for report generators
describe("Report generators with mock client", () => {
  test("getPostgresVersion extracts version info", async () => {
    const mockClient = createMockClient({
      versionRows: [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
    });

    const version = await checkup.getPostgresVersion(mockClient as any);
    expect(version.version).toBe("16.3");
    expect(version.server_version_num).toBe("160003");
    expect(version.server_major_ver).toBe("16");
    expect(version.server_minor_ver).toBe("3");
  });

  test("getSettings transforms rows to keyed object", async () => {
    const mockClient = createMockClient({
      settingsRows: [
        {
          tag_setting_name: "shared_buffers",
          tag_setting_value: "16384",
          tag_unit: "8kB",
          tag_category: "Resource Usage / Memory",
          tag_vartype: "integer",
          is_default: 1,
          setting_normalized: "134217728",  // 16384 * 8192
          unit_normalized: "bytes",
        },
        {
          tag_setting_name: "work_mem",
          tag_setting_value: "4096",
          tag_unit: "kB",
          tag_category: "Resource Usage / Memory",
          tag_vartype: "integer",
          is_default: 1,
          setting_normalized: "4194304",  // 4096 * 1024
          unit_normalized: "bytes",
        },
      ],
    });

    const settings = await checkup.getSettings(mockClient as any);
    expect("shared_buffers" in settings).toBe(true);
    expect("work_mem" in settings).toBe(true);
    expect(settings.shared_buffers.setting).toBe("16384");
    expect(settings.shared_buffers.unit).toBe("8kB");
    // pretty_value is now computed from setting_normalized
    expect(settings.shared_buffers.pretty_value).toBe("128.00 MiB");
    expect(settings.work_mem.pretty_value).toBe("4.00 MiB");
  });

  test("generateA002 creates report with version data", async () => {
    const mockClient = createMockClient({
      versionRows: [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
    });

    const report = await checkup.generateA002(mockClient as any, "test-node");
    expect(report.checkId).toBe("A002");
    expect(report.checkTitle).toBe("Postgres major version");
    expect(report.nodes.primary).toBe("test-node");
    expect("test-node" in report.results).toBe(true);
    expect("version" in report.results["test-node"].data).toBe(true);
    expect(report.results["test-node"].data.version.version).toBe("16.3");
  });

  test("generateA003 creates report with settings and version", async () => {
    const mockClient = createMockClient({
      versionRows: [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
      settingsRows: [
        {
          tag_setting_name: "shared_buffers",
          tag_setting_value: "16384",
          tag_unit: "8kB",
          tag_category: "Resource Usage / Memory",
          tag_vartype: "integer",
          is_default: 1,
          setting_normalized: "134217728",
          unit_normalized: "bytes",
        },
      ],
    });

    const report = await checkup.generateA003(mockClient as any, "test-node");
    expect(report.checkId).toBe("A003");
    expect(report.checkTitle).toBe("Postgres settings");
    expect("test-node" in report.results).toBe(true);
    expect("shared_buffers" in report.results["test-node"].data).toBe(true);
    expect(report.results["test-node"].postgres_version).toBeTruthy();
    expect(report.results["test-node"].postgres_version!.version).toBe("16.3");
  });

  test("generateA013 creates report with minor version data", async () => {
    const mockClient = createMockClient({
      versionRows: [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
    });

    const report = await checkup.generateA013(mockClient as any, "test-node");
    expect(report.checkId).toBe("A013");
    expect(report.checkTitle).toBe("Postgres minor version");
    expect(report.nodes.primary).toBe("test-node");
    expect("test-node" in report.results).toBe(true);
    expect("version" in report.results["test-node"].data).toBe(true);
    expect(report.results["test-node"].data.version.server_minor_ver).toBe("3");
  });

  test("generateAllReports returns reports for all checks", async () => {
    const mockClient = createMockClient({
      versionRows: [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
        settingsRows: [
          {
            tag_setting_name: "shared_buffers",
            tag_setting_value: "16384",
            tag_unit: "8kB",
            tag_category: "Resource Usage / Memory",
            tag_vartype: "integer",
            is_default: 0, // Non-default for A007
            setting_normalized: "134217728",
            unit_normalized: "bytes",
          },
        ],
        databaseSizesRows: [{ datname: "postgres", size_bytes: "1073741824" }],
        dbStatsRows: [{
          numbackends: 5,
          xact_commit: 100,
          xact_rollback: 1,
          blks_read: 1000,
          blks_hit: 9000,
          tup_returned: 500,
          tup_fetched: 400,
          tup_inserted: 50,
          tup_updated: 30,
          tup_deleted: 10,
          deadlocks: 0,
          temp_files: 0,
          temp_bytes: 0,
          postmaster_uptime_s: 864000
        }],
        connectionStatesRows: [{ state: "active", count: 2 }, { state: "idle", count: 3 }],
        uptimeRows: [{ start_time: new Date("2024-01-01T00:00:00Z"), uptime: "10 days" }],
        invalidIndexesRows: [],
        unusedIndexesRows: [],
        redundantIndexesRows: [],
        sensitiveColumnsRows: [],
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
    // S001 is only available in Python reporter, not in CLI express mode
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
    const mockClient = createMockClient({
      settingsRows: [
        { tag_setting_name: "shared_buffers", tag_setting_value: "256MB", tag_unit: "", tag_category: "Resource Usage / Memory", tag_vartype: "string", is_default: 0, setting_normalized: null, unit_normalized: null },
        { tag_setting_name: "work_mem", tag_setting_value: "64MB", tag_unit: "", tag_category: "Resource Usage / Memory", tag_vartype: "string", is_default: 0, setting_normalized: null, unit_normalized: null },
        { tag_setting_name: "default_setting", tag_setting_value: "on", tag_unit: "", tag_category: "Other", tag_vartype: "bool", is_default: 1, setting_normalized: null, unit_normalized: null },
      ],
    });

    const settings = await checkup.getAlteredSettings(mockClient as any);
    expect("shared_buffers" in settings).toBe(true);
    expect("work_mem" in settings).toBe(true);
    expect("default_setting" in settings).toBe(false);  // Should be filtered out
    expect(settings.shared_buffers.value).toBe("256MB");
    expect(settings.work_mem.value).toBe("64MB");
  });

  test("generateA007 creates report with altered settings", async () => {
    const mockClient = createMockClient({
      versionRows: [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
        settingsRows: [
          { tag_setting_name: "max_connections", tag_setting_value: "200", tag_unit: "", tag_category: "Connections and Authentication", tag_vartype: "integer", is_default: 0, setting_normalized: null, unit_normalized: null },
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
    const mockClient = createMockClient({
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
    const mockClient = createMockClient({
      dbStatsRows: [{
        numbackends: 10,
        xact_commit: 1000,
        xact_rollback: 5,
        blks_read: 500,
        blks_hit: 9500,
        tup_returned: 5000,
        tup_fetched: 4000,
        tup_inserted: 100,
        tup_updated: 50,
        tup_deleted: 25,
        deadlocks: 0,
        temp_files: 2,
        temp_bytes: 1048576,
        postmaster_uptime_s: 2592000,  // 30 days
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
    const mockClient = createMockClient({
      versionRows: [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
        databaseSizesRows: [
          { datname: "postgres", size_bytes: "1073741824" },
        ],
        dbStatsRows: [{
          numbackends: 5,
          xact_commit: 100,
          xact_rollback: 1,
          blks_read: 100,
          blks_hit: 900,
          tup_returned: 500,
          tup_fetched: 400,
          tup_inserted: 50,
          tup_updated: 30,
          tup_deleted: 10,
          deadlocks: 0,
          temp_files: 0,
          temp_bytes: 0,
          postmaster_uptime_s: 864000,
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
    const mockClient = createMockClient({
      invalidIndexesRows: [
        { schema_name: "public", table_name: "users", index_name: "users_email_idx", relation_name: "users", index_size_bytes: "1048576", index_definition: "CREATE INDEX users_email_idx ON public.users USING btree (email)", supports_fk: false },
      ],
    });

    const indexes = await checkup.getInvalidIndexes(mockClient as any);
    expect(indexes.length).toBe(1);
    expect(indexes[0].schema_name).toBe("public");
    expect(indexes[0].table_name).toBe("users");
    expect(indexes[0].index_name).toBe("users_email_idx");
    expect(indexes[0].index_size_bytes).toBe(1048576);
    expect(indexes[0].index_size_pretty).toBeTruthy();
    expect(indexes[0].index_definition).toMatch(/^CREATE INDEX/);
    expect(indexes[0].relation_name).toBe("users");
    expect(indexes[0].supports_fk).toBe(false);
  });

  test("generateH001 creates report with invalid indexes", async () => {
    const mockClient = createMockClient({
      versionRows: [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
        invalidIndexesRows: [
          { schema_name: "public", table_name: "orders", index_name: "orders_status_idx", relation_name: "orders", index_size_bytes: "2097152", index_definition: "CREATE INDEX orders_status_idx ON public.orders USING btree (status)", supports_fk: false },
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

  test("getInvalidIndexes returns decision tree fields including valid_duplicate_definition", async () => {
    const mockClient = createMockClient({
      invalidIndexesRows: [
        {
          schema_name: "public",
          table_name: "users",
          index_name: "users_email_idx_invalid",
          relation_name: "users",
          index_size_bytes: "1048576",
          index_definition: "CREATE INDEX users_email_idx_invalid ON public.users USING btree (email)",
          supports_fk: false,
          is_pk: false,
          is_unique: false,
          constraint_name: null,
          table_row_estimate: "5000",
          has_valid_duplicate: true,
          valid_index_name: "users_email_idx",
          valid_index_definition: "CREATE INDEX users_email_idx ON public.users USING btree (email)",
        },
      ],
    });

    const indexes = await checkup.getInvalidIndexes(mockClient as any);
    expect(indexes.length).toBe(1);
    expect(indexes[0].is_pk).toBe(false);
    expect(indexes[0].is_unique).toBe(false);
    expect(indexes[0].constraint_name).toBeNull();
    expect(indexes[0].table_row_estimate).toBe(5000);
    expect(indexes[0].has_valid_duplicate).toBe(true);
    expect(indexes[0].valid_duplicate_name).toBe("users_email_idx");
    expect(indexes[0].valid_duplicate_definition).toBe("CREATE INDEX users_email_idx ON public.users USING btree (email)");
  });

  test("getInvalidIndexes handles has_valid_duplicate: false with null values", async () => {
    const mockClient = createMockClient({
      invalidIndexesRows: [
        {
          schema_name: "public",
          table_name: "orders",
          index_name: "orders_status_idx_invalid",
          relation_name: "orders",
          index_size_bytes: "524288",
          index_definition: "CREATE INDEX orders_status_idx_invalid ON public.orders USING btree (status)",
          supports_fk: false,
          is_pk: false,
          is_unique: false,
          constraint_name: null,
          table_row_estimate: "100000",
          has_valid_duplicate: false,
          valid_index_name: null,
          valid_index_definition: null,
        },
      ],
    });

    const indexes = await checkup.getInvalidIndexes(mockClient as Client);
    expect(indexes.length).toBe(1);
    expect(indexes[0].has_valid_duplicate).toBe(false);
    expect(indexes[0].valid_duplicate_name).toBeNull();
    expect(indexes[0].valid_duplicate_definition).toBeNull();
  });

  test("getInvalidIndexes handles is_pk: true with constraint", async () => {
    const mockClient = createMockClient({
      invalidIndexesRows: [
        {
          schema_name: "public",
          table_name: "accounts",
          index_name: "accounts_pkey_invalid",
          relation_name: "accounts",
          index_size_bytes: "262144",
          index_definition: "CREATE UNIQUE INDEX accounts_pkey_invalid ON public.accounts USING btree (id)",
          supports_fk: true,
          is_pk: true,
          is_unique: true,
          constraint_name: "accounts_pkey",
          table_row_estimate: "500",
          has_valid_duplicate: false,
          valid_index_name: null,
          valid_index_definition: null,
        },
      ],
    });

    const indexes = await checkup.getInvalidIndexes(mockClient as Client);
    expect(indexes.length).toBe(1);
    expect(indexes[0].is_pk).toBe(true);
    expect(indexes[0].is_unique).toBe(true);
    expect(indexes[0].constraint_name).toBe("accounts_pkey");
    expect(indexes[0].supports_fk).toBe(true);
  });

  test("getInvalidIndexes handles is_unique: true without PK", async () => {
    const mockClient = createMockClient({
      invalidIndexesRows: [
        {
          schema_name: "public",
          table_name: "users",
          index_name: "users_email_unique_invalid",
          relation_name: "users",
          index_size_bytes: "131072",
          index_definition: "CREATE UNIQUE INDEX users_email_unique_invalid ON public.users USING btree (email)",
          supports_fk: false,
          is_pk: false,
          is_unique: true,
          constraint_name: "users_email_unique",
          table_row_estimate: "25000",
          has_valid_duplicate: true,
          valid_index_name: "users_email_unique_idx",
          valid_index_definition: "CREATE UNIQUE INDEX users_email_unique_idx ON public.users USING btree (email)",
        },
      ],
    });

    const indexes = await checkup.getInvalidIndexes(mockClient as Client);
    expect(indexes.length).toBe(1);
    expect(indexes[0].is_pk).toBe(false);
    expect(indexes[0].is_unique).toBe(true);
    expect(indexes[0].constraint_name).toBe("users_email_unique");
    expect(indexes[0].has_valid_duplicate).toBe(true);
  });
  // Top-level structure tests removed - covered by schema-validation.test.ts
});

// Tests for H001 decision tree recommendation logic
describe("H001 - Decision tree recommendations", () => {
  // Helper to create a minimal InvalidIndex for testing
  const createTestIndex = (overrides: Partial<checkup.InvalidIndex> = {}): checkup.InvalidIndex => ({
    schema_name: "public",
    table_name: "test_table",
    index_name: "test_idx",
    relation_name: "public.test_table",
    index_size_bytes: 1024,
    index_size_pretty: "1 KiB",
    index_definition: "CREATE INDEX test_idx ON public.test_table USING btree (col)",
    supports_fk: false,
    is_pk: false,
    is_unique: false,
    constraint_name: null,
    table_row_estimate: 100000, // Large table by default
    has_valid_duplicate: false,
    valid_duplicate_name: null,
    valid_duplicate_definition: null,
    ...overrides,
  });

  test("returns DROP when has_valid_duplicate is true", () => {
    const index = createTestIndex({ has_valid_duplicate: true, valid_duplicate_name: "existing_idx" });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("DROP");
  });

  test("returns DROP even when is_pk is true if has_valid_duplicate is true", () => {
    // has_valid_duplicate takes precedence over is_pk
    const index = createTestIndex({
      has_valid_duplicate: true,
      is_pk: true,
      is_unique: true,
    });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("DROP");
  });

  test("returns RECREATE when is_pk is true and no valid duplicate", () => {
    const index = createTestIndex({
      is_pk: true,
      is_unique: true,
      constraint_name: "test_pkey",
    });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("RECREATE");
  });

  test("returns RECREATE when is_unique is true (non-PK) and no valid duplicate", () => {
    const index = createTestIndex({
      is_unique: true,
      constraint_name: "test_unique",
    });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("RECREATE");
  });

  test("returns RECREATE for small table (< 10K rows) without valid duplicate", () => {
    const index = createTestIndex({ table_row_estimate: 5000 });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("RECREATE");
  });

  test("returns RECREATE for table at threshold boundary (9999 rows)", () => {
    const index = createTestIndex({ table_row_estimate: 9999 });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("RECREATE");
  });

  test("returns UNCERTAIN for large table (>= 10K rows) at threshold boundary", () => {
    const index = createTestIndex({ table_row_estimate: 10000 });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("UNCERTAIN");
  });

  test("returns UNCERTAIN for large table without valid duplicate or constraint", () => {
    const index = createTestIndex({ table_row_estimate: 1000000 });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("UNCERTAIN");
  });

  test("returns UNCERTAIN for empty table (0 rows) with no valid duplicate - edge case", () => {
    // Empty table should be RECREATE (< 10K threshold)
    const index = createTestIndex({ table_row_estimate: 0 });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("RECREATE");
  });

  test("decision tree priority: has_valid_duplicate > is_pk > small_table", () => {
    // Even with PK and small table, has_valid_duplicate should win
    const index = createTestIndex({
      has_valid_duplicate: true,
      is_pk: true,
      is_unique: true,
      table_row_estimate: 100,
    });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("DROP");
  });

  test("decision tree priority: is_pk > small_table", () => {
    // is_pk should return RECREATE regardless of table size
    const index = createTestIndex({
      is_pk: true,
      is_unique: true,
      table_row_estimate: 1000000, // Large table
    });
    expect(checkup.getInvalidIndexRecommendation(index)).toBe("RECREATE");
  });
});

// Tests for H002 (Unused indexes)
describe("H002 - Unused indexes", () => {
  test("getUnusedIndexes returns unused indexes", async () => {
    const mockClient = createMockClient({
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
    const mockClient = createMockClient({
      versionRows: [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
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
  // Top-level structure tests removed - covered by schema-validation.test.ts
});

// Tests for H004 (Redundant indexes)
describe("H004 - Redundant indexes", () => {
  test("getRedundantIndexes returns redundant indexes", async () => {
    const mockClient = createMockClient({
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
            { index_name: "public.orders_user_id_created_idx", index_definition: "CREATE INDEX orders_user_id_created_idx ON public.orders USING btree (user_id, created_at)", index_size_bytes: 1048576 }
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
    // Verify redundant_to is populated with definitions and sizes
    expect(indexes[0].redundant_to).toBeInstanceOf(Array);
    expect(indexes[0].redundant_to.length).toBe(1);
    expect(indexes[0].redundant_to[0].index_name).toBe("public.orders_user_id_created_idx");
    expect(indexes[0].redundant_to[0].index_definition).toContain("CREATE INDEX");
    expect(indexes[0].redundant_to[0].index_size_bytes).toBe(1048576);
    expect(indexes[0].redundant_to[0].index_size_pretty).toBe("1.00 MiB");
  });

  test("generateH004 creates report with redundant indexes", async () => {
    const mockClient = createMockClient({
      versionRows: [
        { name: "server_version", setting: "16.3" },
        { name: "server_version_num", setting: "160003" },
      ],
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
              { index_name: "public.products_category_name_idx", index_definition: "CREATE INDEX products_category_name_idx ON public.products USING btree (category, name)", index_size_bytes: 2097152 }
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
  // Top-level structure tests removed - covered by schema-validation.test.ts
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

  test("withRetry succeeds on first attempt", async () => {
    let attempts = 0;
    const result = await api.withRetry(async () => {
      attempts++;
      return "success";
    });
    expect(result).toBe("success");
    expect(attempts).toBe(1);
  });

  test("withRetry retries on retryable errors and succeeds", async () => {
    let attempts = 0;
    const result = await api.withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("connection timeout");
        }
        return "success after retry";
      },
      { maxAttempts: 3, initialDelayMs: 10 }
    );
    expect(result).toBe("success after retry");
    expect(attempts).toBe(3);
  });

  test("withRetry calls onRetry callback", async () => {
    let attempts = 0;
    const retryLogs: string[] = [];
    await api.withRetry(
      async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error("socket hang up");
        }
        return "ok";
      },
      { maxAttempts: 3, initialDelayMs: 10 },
      (attempt, err, delayMs) => {
        retryLogs.push(`attempt ${attempt}, delay ${delayMs}ms`);
      }
    );
    expect(retryLogs.length).toBe(1);
    expect(retryLogs[0]).toMatch(/attempt 1/);
  });

  test("withRetry does not retry on non-retryable errors", async () => {
    let attempts = 0;
    try {
      await api.withRetry(
        async () => {
          attempts++;
          throw new Error("invalid input");
        },
        { maxAttempts: 3, initialDelayMs: 10 }
      );
    } catch (err) {
      expect((err as Error).message).toBe("invalid input");
    }
    expect(attempts).toBe(1);
  });

  test("withRetry does not retry on 4xx RpcError", async () => {
    let attempts = 0;
    try {
      await api.withRetry(
        async () => {
          attempts++;
          throw new api.RpcError({
            rpcName: "test",
            statusCode: 400,
            payloadText: "bad request",
            payloadJson: null,
          });
        },
        { maxAttempts: 3, initialDelayMs: 10 }
      );
    } catch (err) {
      expect(err).toBeInstanceOf(api.RpcError);
    }
    expect(attempts).toBe(1);
  });

  test("withRetry retries on 5xx RpcError", async () => {
    let attempts = 0;
    try {
      await api.withRetry(
        async () => {
          attempts++;
          throw new api.RpcError({
            rpcName: "test",
            statusCode: 503,
            payloadText: "service unavailable",
            payloadJson: null,
          });
        },
        { maxAttempts: 2, initialDelayMs: 10 }
      );
    } catch (err) {
      expect(err).toBeInstanceOf(api.RpcError);
    }
    expect(attempts).toBe(2);
  });

  test("withRetry retries on timeout errors", async () => {
    // Tests that timeout-like error messages are considered retryable
    let attempts = 0;
    try {
      await api.withRetry(
        async () => {
          attempts++;
          throw new Error("RPC test timed out after 30000ms (no response)");
        },
        { maxAttempts: 3, initialDelayMs: 10 }
      );
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("timed out");
    }
    expect(attempts).toBe(3); // Should retry on timeout
  });

  test("withRetry retries on ECONNRESET errors", async () => {
    // Tests that connection reset errors are considered retryable
    let attempts = 0;
    try {
      await api.withRetry(
        async () => {
          attempts++;
          const err = new Error("connection reset") as Error & { code: string };
          err.code = "ECONNRESET";
          throw err;
        },
        { maxAttempts: 2, initialDelayMs: 10 }
      );
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
    expect(attempts).toBe(2); // Should retry on ECONNRESET
  });
});

// Tests for uploadCheckupReportJson response with markdown info
describe("uploadCheckupReportJson response structure", () => {
  test("response includes optional markdown fields", () => {
    // Type check - the function returns optional markdown fields for paid users
    const response: Awaited<ReturnType<typeof api.uploadCheckupReportJson>> = {
      reportChunkId: 123,
      markdownChunkId: 456,
      markdownChunkIds: [456, 789],
      skippedMarkdown: false,
    };
    expect(response.reportChunkId).toBe(123);
    expect(response.markdownChunkId).toBe(456);
    expect(response.markdownChunkIds).toEqual([456, 789]);
  });

  test("response without markdown for non-paid users", () => {
    const response: Awaited<ReturnType<typeof api.uploadCheckupReportJson>> = {
      reportChunkId: 123,
      skippedMarkdown: true,
    };
    expect(response.reportChunkId).toBe(123);
    expect(response.markdownChunkId).toBeUndefined();
    expect(response.skippedMarkdown).toBe(true);
  });
});

