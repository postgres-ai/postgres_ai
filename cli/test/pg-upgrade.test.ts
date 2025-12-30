import { describe, test, expect } from "bun:test";
import {
  parsePostgresVersionFromCompose,
  buildUpgradeScript,
  needsPostgresUpgrade,
} from "../lib/pg-upgrade";

describe("pg-upgrade module", () => {
  describe("parsePostgresVersionFromCompose", () => {
    test("extracts PostgreSQL version from sink-postgres service", () => {
      const compose = `
services:
  target-db:
    image: postgres:15
    container_name: target-db

  sink-postgres:
    image: postgres:18
    container_name: sink-postgres
    environment:
      POSTGRES_DB: postgres
`;
      expect(parsePostgresVersionFromCompose(compose)).toBe(18);
    });

    test("returns null when sink-postgres service not found", () => {
      const compose = `
services:
  other-db:
    image: postgres:15
`;
      expect(parsePostgresVersionFromCompose(compose)).toBeNull();
    });

    test("returns null for empty content", () => {
      expect(parsePostgresVersionFromCompose("")).toBeNull();
    });

    test("handles postgres version 15", () => {
      const compose = `
  sink-postgres:
    image: postgres:15
`;
      expect(parsePostgresVersionFromCompose(compose)).toBe(15);
    });

    test("handles postgres version 17", () => {
      const compose = `
  sink-postgres:
    image: postgres:17
`;
      expect(parsePostgresVersionFromCompose(compose)).toBe(17);
    });

    test("ignores target-db version", () => {
      const compose = `
  target-db:
    image: postgres:14
  sink-postgres:
    image: postgres:18
`;
      // Should return sink-postgres version (18), not target-db (14)
      expect(parsePostgresVersionFromCompose(compose)).toBe(18);
    });
  });

  describe("buildUpgradeScript", () => {
    test("generates script with correct version numbers", () => {
      const script = buildUpgradeScript(15, 18);

      expect(script).toContain("postgresql-15");
      expect(script).toContain("/usr/lib/postgresql/15/bin");
      expect(script).toContain("/usr/lib/postgresql/18/bin");
      expect(script).toContain("/var/lib/postgresql/18/data");
      expect(script).toContain("--link");
    });

    test("includes all required pg_upgrade steps", () => {
      const script = buildUpgradeScript(15, 17);

      expect(script).toContain("apt-get install");
      expect(script).toContain("initdb");
      expect(script).toContain("pg_upgrade");
      expect(script).toContain("--old-datadir");
      expect(script).toContain("--new-datadir");
      expect(script).toContain("--old-bindir");
      expect(script).toContain("--new-bindir");
    });

    test("uses --link mode for efficient upgrade", () => {
      const script = buildUpgradeScript(16, 18);
      expect(script).toContain("--link");
    });

    test("backs up old data directory", () => {
      const script = buildUpgradeScript(15, 18);
      expect(script).toContain("data.old");
    });
  });

  describe("needsPostgresUpgrade", () => {
    test("returns true when versions differ", () => {
      expect(needsPostgresUpgrade(15, 18)).toBe(true);
      expect(needsPostgresUpgrade(17, 18)).toBe(true);
      expect(needsPostgresUpgrade(18, 15)).toBe(true);
    });

    test("returns false when versions match", () => {
      expect(needsPostgresUpgrade(15, 15)).toBe(false);
      expect(needsPostgresUpgrade(18, 18)).toBe(false);
    });

    test("returns false when current version is null", () => {
      expect(needsPostgresUpgrade(null, 18)).toBe(false);
    });

    test("returns false when target version is null", () => {
      expect(needsPostgresUpgrade(15, null)).toBe(false);
    });

    test("returns false when both versions are null", () => {
      expect(needsPostgresUpgrade(null, null)).toBe(false);
    });
  });
});
