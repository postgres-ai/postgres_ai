/**
 * JSON Schema validation tests for H001, H002, H004 express checkup reports.
 * These tests validate that the generated reports match the schemas in reporter/schemas/.
 */
import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { readFileSync } from "fs";
import Ajv2020 from "ajv/dist/2020";

import * as checkup from "../lib/checkup";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemasDir = resolve(import.meta.dir, "../../reporter/schemas");

function loadSchema(checkId: string): object {
  const schemaPath = resolve(schemasDir, `${checkId}.schema.json`);
  return JSON.parse(readFileSync(schemaPath, "utf8"));
}

function validateReport(report: any, checkId: string): { valid: boolean; errors: string[] } {
  const schema = loadSchema(checkId);
  const validate = ajv.compile(schema);
  const valid = validate(report);
  const errors = validate.errors?.map(e => `${e.instancePath}: ${e.message}`) || [];
  return { valid: !!valid, errors };
}

// Mock client for testing
function createMockClient(options: {
  versionRows?: any[];
  settingsRows?: any[];
  invalidIndexesRows?: any[];
  unusedIndexesRows?: any[];
  redundantIndexesRows?: any[];
} = {}) {
  const {
    versionRows = [
      { name: "server_version", setting: "16.3" },
      { name: "server_version_num", setting: "160003" },
    ],
    settingsRows = [
      { tag_setting_name: "shared_buffers", tag_setting_value: "128MB", tag_unit: "", tag_category: "Resource Usage / Memory", tag_vartype: "string", is_default: 1, setting_normalized: null, unit_normalized: null },
      { tag_setting_name: "work_mem", tag_setting_value: "4MB", tag_unit: "", tag_category: "Resource Usage / Memory", tag_vartype: "string", is_default: 1, setting_normalized: null, unit_normalized: null },
      { tag_setting_name: "autovacuum", tag_setting_value: "on", tag_unit: "", tag_category: "Autovacuum", tag_vartype: "bool", is_default: 1, setting_normalized: null, unit_normalized: null },
      { tag_setting_name: "pg_stat_statements.max", tag_setting_value: "5000", tag_unit: "", tag_category: "Custom", tag_vartype: "integer", is_default: 0, setting_normalized: null, unit_normalized: null },
    ],
    invalidIndexesRows = [],
    unusedIndexesRows = [],
    redundantIndexesRows = [],
  } = options;

  return {
    query: async (sql: string) => {
      // Version query (simple inline - used by getPostgresVersion)
      if (sql.includes("server_version") && sql.includes("server_version_num") && sql.includes("pg_settings") && !sql.includes("tag_setting_name")) {
        return { rows: versionRows };
      }
      // Settings metric query (from metrics.yml - has tag_setting_name, tag_setting_value)
      if (sql.includes("tag_setting_name") && sql.includes("tag_setting_value") && sql.includes("pg_settings")) {
        return { rows: settingsRows };
      }
      // db_size metric (current database size from metrics.yml)
      if (sql.includes("pg_database_size(current_database())") && sql.includes("size_b")) {
        return { rows: [{ tag_datname: "testdb", size_b: "1073741824" }] };
      }
      // Stats reset metric (from metrics.yml)
      if (sql.includes("stats_reset") && sql.includes("pg_stat_database") && sql.includes("seconds_since_reset")) {
        return { rows: [{ 
          tag_database_name: "testdb",
          stats_reset_epoch: "1704067200", 
          seconds_since_reset: "2592000"
        }] };
      }
      // Postmaster startup time (simple inline - used by getStatsReset)
      if (sql.includes("pg_postmaster_start_time") && sql.includes("postmaster_startup_epoch")) {
        return { rows: [{ 
          postmaster_startup_epoch: "1704067200",
          postmaster_startup_time: "2024-01-01 00:00:00+00"
        }] };
      }
      // Invalid indexes (H001) - from metrics.yml
      if (sql.includes("indisvalid = false") && sql.includes("fk_indexes")) {
        return { rows: invalidIndexesRows };
      }
      // Unused indexes (H002) - from metrics.yml
      if (sql.includes("Never Used Indexes") && sql.includes("idx_scan = 0")) {
        return { rows: unusedIndexesRows };
      }
      // Redundant indexes (H004) - from metrics.yml
      if (sql.includes("redundant_indexes_grouped") && sql.includes("columns like")) {
        return { rows: redundantIndexesRows };
      }
      // D004: pg_stat_statements extension check
      if (sql.includes("pg_extension") && sql.includes("pg_stat_statements")) {
        return { rows: [] }; // Extension not installed
      }
      // D004: pg_stat_kcache extension check
      if (sql.includes("pg_extension") && sql.includes("pg_stat_kcache")) {
        return { rows: [] }; // Extension not installed
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

describe("H001 schema validation", () => {
  test("H001 report with empty data validates against schema", async () => {
    const mockClient = createMockClient({ invalidIndexesRows: [] });
    const report = await checkup.generateH001(mockClient as any, "node-01");
    
    const result = validateReport(report, "H001");
    if (!result.valid) {
      console.error("H001 validation errors:", result.errors);
    }
    expect(result.valid).toBe(true);
  });

  test("H001 report with data validates against schema", async () => {
    const mockClient = createMockClient({
      invalidIndexesRows: [
        { 
          schema_name: "public", 
          table_name: "users", 
          index_name: "users_email_idx", 
          relation_name: "users",
          index_size_bytes: "1048576",
          supports_fk: false
        },
      ],
    });
    const report = await checkup.generateH001(mockClient as any, "node-01");
    
    const result = validateReport(report, "H001");
    if (!result.valid) {
      console.error("H001 validation errors:", result.errors);
    }
    expect(result.valid).toBe(true);
  });
});

describe("H002 schema validation", () => {
  test("H002 report with empty data validates against schema", async () => {
    const mockClient = createMockClient({ unusedIndexesRows: [] });
    const report = await checkup.generateH002(mockClient as any, "node-01");
    
    const result = validateReport(report, "H002");
    if (!result.valid) {
      console.error("H002 validation errors:", result.errors);
    }
    expect(result.valid).toBe(true);
  });

  test("H002 report with data validates against schema", async () => {
    const mockClient = createMockClient({
      unusedIndexesRows: [
        { 
          schema_name: "public", 
          table_name: "logs", 
          index_name: "logs_created_idx",
          index_definition: "CREATE INDEX logs_created_idx ON public.logs USING btree (created_at)",
          reason: "Never Used Indexes",
          idx_scan: "0",
          index_size_bytes: "8388608",
          idx_is_btree: true,
          supports_fk: false
        },
      ],
    });
    const report = await checkup.generateH002(mockClient as any, "node-01");
    
    const result = validateReport(report, "H002");
    if (!result.valid) {
      console.error("H002 validation errors:", result.errors);
    }
    expect(result.valid).toBe(true);
  });
});

describe("H004 schema validation", () => {
  test("H004 report with empty data validates against schema", async () => {
    const mockClient = createMockClient({ redundantIndexesRows: [] });
    const report = await checkup.generateH004(mockClient as any, "node-01");
    
    const result = validateReport(report, "H004");
    if (!result.valid) {
      console.error("H004 validation errors:", result.errors);
    }
    expect(result.valid).toBe(true);
  });

  test("H004 report with data validates against schema", async () => {
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
          ])
        },
      ],
    });
    const report = await checkup.generateH004(mockClient as any, "node-01");
    
    const result = validateReport(report, "H004");
    if (!result.valid) {
      console.error("H004 validation errors:", result.errors);
    }
    expect(result.valid).toBe(true);
  });
});

describe("D004 schema validation", () => {
  test("D004 report validates against schema (extensions not installed)", async () => {
    const mockClient = createMockClient();
    const report = await checkup.REPORT_GENERATORS.D004(mockClient as any, "node-01");
    
    const result = validateReport(report, "D004");
    if (!result.valid) {
      console.error("D004 validation errors:", result.errors);
    }
    expect(result.valid).toBe(true);
  });
});

describe("F001 schema validation", () => {
  test("F001 report validates against schema", async () => {
    const mockClient = createMockClient();
    const report = await checkup.REPORT_GENERATORS.F001(mockClient as any, "node-01");
    
    const result = validateReport(report, "F001");
    if (!result.valid) {
      console.error("F001 validation errors:", result.errors);
    }
    expect(result.valid).toBe(true);
  });
});

describe("G001 schema validation", () => {
  test("G001 report validates against schema", async () => {
    const mockClient = createMockClient();
    const report = await checkup.REPORT_GENERATORS.G001(mockClient as any, "node-01");
    
    const result = validateReport(report, "G001");
    if (!result.valid) {
      console.error("G001 validation errors:", result.errors);
    }
    expect(result.valid).toBe(true);
  });
});

