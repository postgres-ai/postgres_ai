/**
 * JSON Schema validation tests for express checkup reports.
 * Validates that generated reports match schemas in reporter/schemas/.
 */
import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { readFileSync } from "fs";
import Ajv2020 from "ajv/dist/2020";

import * as checkup from "../lib/checkup";
import { createMockClient } from "./test-utils";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemasDir = resolve(import.meta.dir, "../../reporter/schemas");

function validateAgainstSchema(report: any, checkId: string): void {
  const schemaPath = resolve(schemasDir, `${checkId}.schema.json`);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const validate = ajv.compile(schema);
  const valid = validate(report);
  if (!valid) {
    const errors = validate.errors?.map(e => `${e.instancePath}: ${e.message}`).join(", ");
    throw new Error(`${checkId} schema validation failed: ${errors}`);
  }
}

// Test data for index reports
const indexTestData = {
  H001: {
    emptyRows: { invalidIndexesRows: [] },
    dataRows: {
      invalidIndexesRows: [
        { schema_name: "public", table_name: "users", index_name: "users_email_idx", relation_name: "users", index_size_bytes: "1048576", supports_fk: false },
      ],
    },
  },
  H002: {
    emptyRows: { unusedIndexesRows: [] },
    dataRows: {
      unusedIndexesRows: [
        { schema_name: "public", table_name: "logs", index_name: "logs_created_idx", index_definition: "CREATE INDEX logs_created_idx ON public.logs USING btree (created_at)", reason: "Never Used Indexes", idx_scan: "0", index_size_bytes: "8388608", idx_is_btree: true, supports_fk: false },
      ],
    },
  },
  H004: {
    emptyRows: { redundantIndexesRows: [] },
    dataRows: {
      redundantIndexesRows: [
        { schema_name: "public", table_name: "orders", index_name: "orders_user_id_idx", relation_name: "orders", access_method: "btree", reason: "public.orders_user_id_created_idx", index_size_bytes: "2097152", table_size_bytes: "16777216", index_usage: "0", supports_fk: false, index_definition: "CREATE INDEX orders_user_id_idx ON public.orders USING btree (user_id)", redundant_to_json: JSON.stringify([{ index_name: "public.orders_user_id_created_idx", index_definition: "CREATE INDEX ...", index_size_bytes: 1048576 }]) },
      ],
    },
  },
};

describe("Schema validation", () => {
  // Index health checks (H001, H002, H004) - test empty and with data
  for (const [checkId, testData] of Object.entries(indexTestData)) {
    const generator = checkup.REPORT_GENERATORS[checkId];

    test(`${checkId} validates with empty data`, async () => {
      const mockClient = createMockClient(testData.emptyRows);
      const report = await generator(mockClient as any, "node-01");
      validateAgainstSchema(report, checkId);
    });

    test(`${checkId} validates with sample data`, async () => {
      const mockClient = createMockClient(testData.dataRows);
      const report = await generator(mockClient as any, "node-01");
      validateAgainstSchema(report, checkId);
    });
  }

  // Settings reports (D004, F001, G001) - single test each
  for (const checkId of ["D004", "F001", "G001"]) {
    test(`${checkId} validates against schema`, async () => {
      const mockClient = createMockClient();
      const report = await checkup.REPORT_GENERATORS[checkId](mockClient as any, "node-01");
      validateAgainstSchema(report, checkId);
    });
  }
});
