/**
 * Tests that config files are consistent with what the CLI expects.
 * Catches schema mismatches like pg_statistic in wrong schema.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const configDir = resolve(import.meta.dir, "../../config");

describe("Config consistency", () => {
  test("target-db/init.sql creates pg_statistic in postgres_ai schema", () => {
    const initSql = readFileSync(resolve(configDir, "target-db/init.sql"), "utf8");

    // Must create postgres_ai schema
    expect(initSql).toMatch(/create\s+schema\s+if\s+not\s+exists\s+postgres_ai/i);

    // Must create view in postgres_ai schema, not public
    expect(initSql).toMatch(/create\s+or\s+replace\s+view\s+postgres_ai\.pg_statistic/i);
    expect(initSql).not.toMatch(/create\s+or\s+replace\s+view\s+public\.pg_statistic/i);

    // Must grant on postgres_ai.pg_statistic
    expect(initSql).toMatch(/grant\s+select\s+on\s+postgres_ai\.pg_statistic/i);
  });

  test("pgwatch metrics.yml uses postgres_ai.pg_statistic", () => {
    const metricsYml = readFileSync(
      resolve(configDir, "pgwatch-prometheus/metrics.yml"),
      "utf8"
    );

    // Should reference postgres_ai.pg_statistic, not public.pg_statistic
    expect(metricsYml).not.toMatch(/public\.pg_statistic/);
    expect(metricsYml).toMatch(/postgres_ai\.pg_statistic/);
  });
});
