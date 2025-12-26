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
  invalidIndexesRows?: any[];
  unusedIndexesRows?: any[];
  redundantIndexesRows?: any[];
} = {}) {
  const {
    versionRows = [
      { name: "server_version", setting: "16.3" },
      { name: "server_version_num", setting: "160003" },
    ],
    invalidIndexesRows = [],
    unusedIndexesRows = [],
    redundantIndexesRows = [],
  } = options;

  return {
    query: async (sql: string) => {
      if (sql.includes("server_version") && sql.includes("server_version_num") && !sql.includes("ORDER BY")) {
        return { rows: versionRows };
      }
      if (sql.includes("current_database()") && sql.includes("pg_database_size")) {
        return { rows: [{ datname: "testdb", size_bytes: "1073741824" }] };
      }
      if (sql.includes("stats_reset") && sql.includes("pg_stat_database")) {
        return { rows: [{ 
          stats_reset_epoch: "1704067200", 
          stats_reset_time: "2024-01-01 00:00:00+00",
          days_since_reset: "30",
          postmaster_startup_epoch: "1704067200",
          postmaster_startup_time: "2024-01-01 00:00:00+00"
        }] };
      }
      if (sql.includes("indisvalid = false")) {
        return { rows: invalidIndexesRows };
      }
      if (sql.includes("Never Used Indexes") && sql.includes("idx_scan = 0")) {
        return { rows: unusedIndexesRows };
      }
      if (sql.includes("redundant_indexes") && sql.includes("columns LIKE")) {
        return { rows: redundantIndexesRows };
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
          index_definition: "CREATE INDEX orders_user_id_idx ON public.orders USING btree (user_id)"
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

