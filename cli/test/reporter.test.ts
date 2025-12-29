import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { PostgresReportGenerator, Report } from "../lib/reporter";

describe("PostgresReportGenerator", () => {
  let generator: PostgresReportGenerator;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    generator = new PostgresReportGenerator(
      "http://test-prometheus:9090",
      "postgresql://test@localhost:5432/test"
    );
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Mock successful Prometheus response
  function mockPrometheusSuccess(result: unknown[] = []) {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ status: "success", data: { result } }),
          { status: 200 }
        )
      )
    );
  }

  // Mock error Prometheus response
  function mockPrometheusError() {
    global.fetch = mock(() => Promise.reject(new Error("Connection refused")));
  }

  describe("testConnection", () => {
    test("returns true when Prometheus is available", async () => {
      mockPrometheusSuccess();
      const result = await generator.testConnection();
      expect(result).toBe(true);
    });

    test("returns false when Prometheus is unavailable", async () => {
      mockPrometheusError();
      const result = await generator.testConnection();
      expect(result).toBe(false);
    });
  });

  describe("getAllClusters", () => {
    test("returns list of clusters", async () => {
      mockPrometheusSuccess([
        { metric: { cluster: "cluster1" } },
        { metric: { cluster: "cluster2" } },
      ]);

      const clusters = await generator.getAllClusters();
      expect(clusters).toContain("cluster1");
      expect(clusters).toContain("cluster2");
    });

    test("returns empty array on error", async () => {
      mockPrometheusError();
      const clusters = await generator.getAllClusters();
      expect(clusters).toEqual([]);
    });
  });

  describe("getAllNodes", () => {
    test("returns list of nodes for cluster", async () => {
      mockPrometheusSuccess([
        { metric: { instance: "node1:5432" } },
        { metric: { instance: "node2:5432" } },
      ]);

      const nodes = await generator.getAllNodes("cluster1");
      expect(nodes).toContain("node1:5432");
      expect(nodes).toContain("node2:5432");
    });

    test("returns empty array on error", async () => {
      mockPrometheusError();
      const nodes = await generator.getAllNodes("cluster1");
      expect(nodes).toEqual([]);
    });
  });

  describe("getAllDatabases", () => {
    test("returns list of databases excluding system ones", async () => {
      mockPrometheusSuccess([
        { metric: { datname: "mydb" } },
        { metric: { datname: "template0" } },
        { metric: { datname: "template1" } },
      ]);

      const databases = await generator.getAllDatabases("cluster1");
      expect(databases).toContain("mydb");
      expect(databases).not.toContain("template0");
      expect(databases).not.toContain("template1");
    });

    test("returns empty array on error", async () => {
      mockPrometheusError();
      const databases = await generator.getAllDatabases("cluster1");
      expect(databases).toEqual([]);
    });
  });

  describe("createBaseReport", () => {
    test("creates correct report structure", () => {
      const report = generator.createBaseReport("A002", "Postgres major version", "node-01");

      expect(report.checkId).toBe("A002");
      expect(report.checkTitle).toBe("Postgres major version");
      expect(report.generation_mode).toBe("full");
      expect(report.nodes.primary).toBe("node-01");
      expect(report.nodes.standbys).toEqual([]);
      expect(report.results).toEqual({});
      expect(typeof report.timestamptz).toBe("string");
    });
  });

  describe("generateA002Report", () => {
    test("generates PostgreSQL version report", async () => {
      let queryCount = 0;
      global.fetch = mock(() => {
        queryCount++;
        if (queryCount === 1) {
          // First query for server_version
          return Promise.resolve(
            new Response(
              JSON.stringify({
                status: "success",
                data: {
                  result: [
                    {
                      metric: {
                        tag_setting_name: "server_version",
                        tag_setting_value: "16.3",
                      },
                    },
                  ],
                },
              }),
              { status: 200 }
            )
          );
        }
        // Second query for server_version_num
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "success",
              data: {
                result: [
                  {
                    metric: {
                      tag_setting_name: "server_version_num",
                      tag_setting_value: "160003",
                    },
                  },
                ],
              },
            }),
            { status: 200 }
          )
        );
      });

      const report = await generator.generateA002Report("cluster1", "node-01");

      expect(report.checkId).toBe("A002");
      expect(report.checkTitle).toBe("Postgres major version");
      expect(report.nodes.primary).toBe("node-01");
      expect(report.results["node-01"]).toBeDefined();
    });
  });

  describe("generateA003Report", () => {
    test("generates settings report", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: "success",
              data: {
                result: [
                  {
                    metric: {
                      tag_setting_name: "shared_buffers",
                      tag_setting_value: "128MB",
                      tag_unit: "",
                      tag_category: "Resource Usage / Memory",
                      tag_vartype: "string",
                    },
                  },
                ],
              },
            }),
            { status: 200 }
          )
        )
      );

      const report = await generator.generateA003Report("cluster1", "node-01");

      expect(report.checkId).toBe("A003");
      expect(report.checkTitle).toBe("Postgres settings");
    });
  });

  describe("generateA007Report", () => {
    test("generates altered settings report", async () => {
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: "success",
              data: {
                result: [
                  {
                    metric: {
                      tag_setting_name: "max_connections",
                      tag_setting_value: "200",
                      tag_unit: "",
                      tag_category: "Connections",
                      is_default: "0",
                    },
                  },
                ],
              },
            }),
            { status: 200 }
          )
        )
      );

      const report = await generator.generateA007Report("cluster1", "node-01");

      expect(report.checkId).toBe("A007");
      expect(report.checkTitle).toBe("Altered settings");
    });
  });

  describe("generateD004Report", () => {
    test("generates pg_stat_statements settings report", async () => {
      mockPrometheusSuccess([
        {
          metric: {
            tag_setting_name: "pg_stat_statements.max",
            tag_setting_value: "10000",
          },
        },
      ]);

      const report = await generator.generateD004Report("cluster1", "node-01");

      expect(report.checkId).toBe("D004");
      expect(report.checkTitle).toBe("pg_stat_statements and pg_stat_kcache settings");
    });
  });

  describe("generateF001Report", () => {
    test("generates autovacuum settings report", async () => {
      mockPrometheusSuccess([
        {
          metric: {
            tag_setting_name: "autovacuum",
            tag_setting_value: "on",
          },
        },
      ]);

      const report = await generator.generateF001Report("cluster1", "node-01");

      expect(report.checkId).toBe("F001");
      expect(report.checkTitle).toBe("Autovacuum: current settings");
    });
  });

  describe("generateG001Report", () => {
    test("generates memory settings report", async () => {
      mockPrometheusSuccess([
        {
          metric: {
            tag_setting_name: "shared_buffers",
            tag_setting_value: "128MB",
          },
        },
      ]);

      const report = await generator.generateG001Report("cluster1", "node-01");

      expect(report.checkId).toBe("G001");
      expect(report.checkTitle).toBe("Memory-related settings");
    });
  });

  describe("generateF004Report", () => {
    test("generates heap bloat report", async () => {
      mockPrometheusSuccess([
        {
          metric: {
            datname: "mydb",
            schemaname: "public",
            tablename: "users",
          },
          value: [1704067200, "25.5"],
        },
      ]);

      const report = await generator.generateF004Report("cluster1", "node-01");

      expect(report.checkId).toBe("F004");
      expect(report.checkTitle).toBe("Heap bloat");
    });

    test("excludes system databases from heap bloat", async () => {
      mockPrometheusSuccess([
        {
          metric: {
            datname: "template0",
            schemaname: "public",
            tablename: "test",
          },
          value: [1704067200, "30.0"],
        },
      ]);

      const report = await generator.generateF004Report("cluster1", "node-01");
      expect(Object.keys(report.results["node-01"].data)).toHaveLength(0);
    });
  });

  describe("generateF005Report", () => {
    test("generates btree bloat report", async () => {
      mockPrometheusSuccess([
        {
          metric: {
            datname: "mydb",
            schemaname: "public",
            tblname: "users",
            idxname: "users_pkey",
          },
          value: [1704067200, "22.0"],
        },
      ]);

      const report = await generator.generateF005Report("cluster1", "node-01");

      expect(report.checkId).toBe("F005");
      expect(report.checkTitle).toBe("Btree bloat");
    });
  });

  describe("generateH001Report", () => {
    test("generates invalid indexes report", async () => {
      mockPrometheusSuccess([
        {
          metric: {
            datname: "mydb",
            schemaname: "public",
            tablename: "users",
            indexname: "users_invalid_idx",
          },
          value: [1704067200, "1"],
        },
      ]);

      const report = await generator.generateH001Report("cluster1", "node-01");

      expect(report.checkId).toBe("H001");
      expect(report.checkTitle).toBe("Invalid indexes");
    });
  });

  describe("generateH002Report", () => {
    test("generates unused indexes report", async () => {
      mockPrometheusSuccess([
        {
          metric: {
            datname: "mydb",
            schemaname: "public",
            tablename: "users",
            indexname: "users_unused_idx",
          },
          value: [1704067200, "0"],
        },
      ]);

      const report = await generator.generateH002Report("cluster1", "node-01");

      expect(report.checkId).toBe("H002");
      expect(report.checkTitle).toBe("Unused indexes");
    });
  });

  describe("generateAllReports", () => {
    test("generates all reports for a cluster", async () => {
      mockPrometheusSuccess([]);

      const reports = await generator.generateAllReports("cluster1", "node-01");

      expect("A002" in reports).toBe(true);
      expect("A003" in reports).toBe(true);
      expect("A007" in reports).toBe(true);
      expect("D004" in reports).toBe(true);
      expect("F001" in reports).toBe(true);
      expect("F004" in reports).toBe(true);
      expect("F005" in reports).toBe(true);
      expect("G001" in reports).toBe(true);
      expect("H001" in reports).toBe(true);
      expect("H002" in reports).toBe(true);
    });
  });

  describe("getSettings with filter", () => {
    test("filters settings by provided list", async () => {
      mockPrometheusSuccess([
        {
          metric: {
            tag_setting_name: "autovacuum",
            tag_setting_value: "on",
          },
        },
        {
          metric: {
            tag_setting_name: "shared_buffers",
            tag_setting_value: "128MB",
          },
        },
      ]);

      const settings = await generator.getSettings("cluster1", "node-01", ["autovacuum"]);

      expect("autovacuum" in settings).toBe(true);
      expect("shared_buffers" in settings).toBe(false);
    });
  });

  describe("excluded databases", () => {
    test("uses default exclusions", async () => {
      mockPrometheusSuccess([
        { metric: { datname: "mydb" } },
        { metric: { datname: "rdsadmin" } },
      ]);

      const databases = await generator.getAllDatabases("cluster1");
      expect(databases).toContain("mydb");
      expect(databases).not.toContain("rdsadmin");
    });

    test("supports custom exclusions", async () => {
      const customGenerator = new PostgresReportGenerator(
        "http://test-prometheus:9090",
        "postgresql://test@localhost:5432/test",
        ["customdb"]
      );

      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status: "success",
              data: {
                result: [
                  { metric: { datname: "mydb" } },
                  { metric: { datname: "customdb" } },
                ],
              },
            }),
            { status: 200 }
          )
        )
      );

      const databases = await customGenerator.getAllDatabases("cluster1");
      expect(databases).toContain("mydb");
      expect(databases).not.toContain("customdb");
    });
  });
});
