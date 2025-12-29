import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  parseTimeParam,
  toCSV,
  prometheusToPgssDict,
  prometheusTableToDict,
  processPgssData,
  processTableStatsWithRates,
  PrometheusClient,
  MetricsServer,
} from "../lib/metrics-server";

// Test parseTimeParam
describe("parseTimeParam", () => {
  test("parses Unix timestamp", () => {
    const date = parseTimeParam("1704067200");
    expect(date.getTime()).toBe(1704067200000);
  });

  test("parses ISO format", () => {
    const date = parseTimeParam("2024-01-01T00:00:00Z");
    expect(date.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  test("parses ISO format without Z", () => {
    const date = parseTimeParam("2024-01-01T00:00:00+00:00");
    expect(date.getFullYear()).toBe(2024);
  });

  test("throws on invalid format", () => {
    expect(() => parseTimeParam("invalid")).toThrow();
  });
});

// Test toCSV
describe("toCSV", () => {
  test("creates empty CSV with headers only", () => {
    const result = toCSV([], ["col1", "col2"]);
    expect(result).toBe("col1,col2\n");
  });

  test("creates CSV with data", () => {
    const data = [
      { col1: "a", col2: "b" },
      { col1: "c", col2: "d" },
    ];
    const result = toCSV(data, ["col1", "col2"]);
    expect(result).toBe("col1,col2\na,b\nc,d\n");
  });

  test("handles missing values", () => {
    const data = [{ col1: "a" }];
    const result = toCSV(data, ["col1", "col2"]);
    expect(result).toBe("col1,col2\na,\n");
  });

  test("escapes commas in values", () => {
    const data = [{ col1: "a,b", col2: "c" }];
    const result = toCSV(data, ["col1", "col2"]);
    expect(result).toContain('"a,b"');
  });

  test("escapes quotes in values", () => {
    const data = [{ col1: 'a"b', col2: "c" }];
    const result = toCSV(data, ["col1", "col2"]);
    expect(result).toContain('"a""b"');
  });

  test("escapes newlines in values", () => {
    const data = [{ col1: "a\nb", col2: "c" }];
    const result = toCSV(data, ["col1", "col2"]);
    expect(result).toContain('"a\nb"');
  });

  test("handles null and undefined", () => {
    const data = [{ col1: null, col2: undefined }];
    const result = toCSV(data as unknown as Record<string, unknown>[], ["col1", "col2"]);
    expect(result).toBe("col1,col2\n,\n");
  });
});

// Test prometheusToPgssDict
describe("prometheusToPgssDict", () => {
  test("returns empty map for empty input", () => {
    const result = prometheusToPgssDict([], new Date());
    expect(result.size).toBe(0);
  });

  test("parses single metric", () => {
    const timestamp = new Date("2024-01-01T00:00:00Z");
    const data = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_calls",
          datname: "testdb",
          queryid: "12345",
          user: "postgres",
          instance: "localhost",
        },
        values: [[timestamp.getTime() / 1000, "100"]],
      },
    ];

    const result = prometheusToPgssDict(data as any, timestamp);
    expect(result.size).toBe(1);

    const key = "testdb|12345|postgres|localhost";
    expect(result.has(key)).toBe(true);
    expect(result.get(key)?.calls).toBe(100);
  });

  test("handles entry with value instead of values", () => {
    const timestamp = new Date("2024-01-01T00:00:00Z");
    const data = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_calls",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        value: [timestamp.getTime() / 1000, "50"],
      },
    ];

    const result = prometheusToPgssDict(data as any, timestamp);
    expect(result.size).toBe(1);
    expect(result.get("db|1|u|i")?.calls).toBe(50);
  });

  test("skips entries without values", () => {
    const data = [
      {
        metric: { __name__: "test", datname: "db" },
        values: [],
      },
    ];

    const result = prometheusToPgssDict(data as any, new Date());
    expect(result.size).toBe(0);
  });

  test("finds closest value to timestamp", () => {
    const target = new Date("2024-01-01T00:05:00Z");
    const data = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_calls",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        values: [
          [new Date("2024-01-01T00:00:00Z").getTime() / 1000, "100"],
          [new Date("2024-01-01T00:04:00Z").getTime() / 1000, "150"],
          [new Date("2024-01-01T00:10:00Z").getTime() / 1000, "200"],
        ],
      },
    ];

    const result = prometheusToPgssDict(data as any, target);
    // Should pick the 00:04:00 value as closest to 00:05:00
    expect(result.get("db|1|u|i")?.calls).toBe(150);
  });
});

// Test prometheusTableToDict
describe("prometheusTableToDict", () => {
  test("returns empty map for empty input", () => {
    const result = prometheusTableToDict(new Map(), new Date());
    expect(result.size).toBe(0);
  });

  test("parses table metrics", () => {
    const timestamp = new Date("2024-01-01T00:00:00Z");
    const data = new Map([
      [
        "seq_scan",
        [
          {
            metric: { datname: "db", schemaname: "public", relname: "users" },
            values: [[timestamp.getTime() / 1000, "100"]],
          },
        ],
      ],
    ]);

    const result = prometheusTableToDict(data as any, timestamp);
    expect(result.size).toBe(1);
    expect(result.get("db|public|users")?.seq_scan).toBe(100);
  });

  test("handles different schema label names", () => {
    const timestamp = new Date("2024-01-01T00:00:00Z");
    const data = new Map([
      [
        "seq_scan",
        [
          {
            metric: { datname: "db", schema: "myschema", table_name: "mytable" },
            values: [[timestamp.getTime() / 1000, "50"]],
          },
        ],
      ],
    ]);

    const result = prometheusTableToDict(data as any, timestamp);
    expect(result.has("db|myschema|mytable")).toBe(true);
  });
});

// Test processPgssData
describe("processPgssData", () => {
  test("returns empty array for empty input", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-02T00:00:00Z");
    const result = processPgssData([], [], start, end);
    expect(result).toEqual([]);
  });

  test("calculates differences correctly", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-02T00:00:00Z");

    const startData = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_calls",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        values: [[start.getTime() / 1000, "100"]],
      },
    ];

    const endData = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_calls",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        values: [[end.getTime() / 1000, "200"]],
      },
    ];

    const result = processPgssData(startData as any, endData as any, start, end);
    expect(result.length).toBe(1);
    expect(result[0].calls).toBe(100); // 200 - 100
    expect(result[0].queryid).toBe("1");
  });

  test("handles missing end data (fallback duration)", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-02T00:00:00Z");

    const startData = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_calls",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        values: [[start.getTime() / 1000, "100"]],
      },
    ];

    const result = processPgssData(startData as any, [], start, end);
    expect(result.length).toBe(1);
    expect(result[0].duration_seconds).toBe(86400); // 1 day
  });

  test("calculates rates per second", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-01T01:00:00Z"); // 1 hour later

    const startData = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_calls",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        values: [[start.getTime() / 1000, "0"]],
      },
    ];

    const endData = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_calls",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        values: [[end.getTime() / 1000, "3600"]],
      },
    ];

    const result = processPgssData(startData as any, endData as any, start, end);
    expect(result[0].calls).toBe(3600);
    expect(result[0].calls_per_sec).toBe(1); // 3600 calls / 3600 seconds
  });

  test("sorts by exec_time descending", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-02T00:00:00Z");

    const startData = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_exec_time_total",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        values: [[start.getTime() / 1000, "100"]],
      },
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_exec_time_total",
          datname: "db",
          queryid: "2",
          user: "u",
          instance: "i",
        },
        values: [[start.getTime() / 1000, "200"]],
      },
    ];

    const endData = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_exec_time_total",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        values: [[end.getTime() / 1000, "150"]],
      },
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_exec_time_total",
          datname: "db",
          queryid: "2",
          user: "u",
          instance: "i",
        },
        values: [[end.getTime() / 1000, "500"]],
      },
    ];

    const result = processPgssData(startData as any, endData as any, start, end);
    expect(result.length).toBe(2);
    // Query 2 has higher exec_time diff (300 vs 50)
    expect(result[0].queryid).toBe("2");
  });

  test("handles zero duration", () => {
    const now = new Date("2024-01-01T00:00:00Z");

    const startData = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_calls",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        values: [[now.getTime() / 1000, "100"]],
      },
    ];

    const endData = [
      {
        metric: {
          __name__: "pgwatch_pg_stat_statements_calls",
          datname: "db",
          queryid: "1",
          user: "u",
          instance: "i",
        },
        values: [[now.getTime() / 1000, "200"]],
      },
    ];

    const result = processPgssData(startData as any, endData as any, now, now);
    expect(result[0].calls_per_sec).toBe(0); // Zero duration = 0 rate
  });
});

// Test processTableStatsWithRates
describe("processTableStatsWithRates", () => {
  test("returns empty array for empty input", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-02T00:00:00Z");
    const result = processTableStatsWithRates(new Map(), new Map(), start, end);
    expect(result).toEqual([]);
  });

  test("calculates table stats with rates", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-02T00:00:00Z");

    const startData = new Map([
      [
        "seq_scan",
        [
          {
            metric: { datname: "db", schemaname: "public", relname: "users" },
            values: [[start.getTime() / 1000, "100"]],
          },
        ],
      ],
    ]);

    const endData = new Map([
      [
        "seq_scan",
        [
          {
            metric: { datname: "db", schemaname: "public", relname: "users" },
            values: [[end.getTime() / 1000, "200"]],
          },
        ],
      ],
    ]);

    const result = processTableStatsWithRates(startData as any, endData as any, start, end);
    expect(result.length).toBe(1);
    expect(result[0].schema).toBe("public");
    expect(result[0].table_name).toBe("users");
    expect(result[0].seq_scans).toBe(100);
  });

  test("handles zero duration", () => {
    const now = new Date("2024-01-01T00:00:00Z");

    const startData = new Map([
      [
        "seq_scan",
        [
          {
            metric: { datname: "db", schemaname: "public", relname: "users" },
            values: [[now.getTime() / 1000, "100"]],
          },
        ],
      ],
    ]);

    const endData = new Map([
      [
        "seq_scan",
        [
          {
            metric: { datname: "db", schemaname: "public", relname: "users" },
            values: [[now.getTime() / 1000, "200"]],
          },
        ],
      ],
    ]);

    const result = processTableStatsWithRates(startData as any, endData as any, now, now);
    expect(result[0].seq_scans_per_sec).toBe(0);
  });

  test("sorts by total_size descending", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-02T00:00:00Z");

    const startData = new Map([
      [
        "total_size",
        [
          {
            metric: { datname: "db", schemaname: "public", relname: "small" },
            values: [[start.getTime() / 1000, "1000"]],
          },
          {
            metric: { datname: "db", schemaname: "public", relname: "large" },
            values: [[start.getTime() / 1000, "10000"]],
          },
        ],
      ],
    ]);

    const endData = new Map([
      [
        "total_size",
        [
          {
            metric: { datname: "db", schemaname: "public", relname: "small" },
            values: [[end.getTime() / 1000, "1000"]],
          },
          {
            metric: { datname: "db", schemaname: "public", relname: "large" },
            values: [[end.getTime() / 1000, "10000"]],
          },
        ],
      ],
    ]);

    const result = processTableStatsWithRates(startData as any, endData as any, start, end);
    expect(result.length).toBe(2);
    // Large table should be first
    expect(result[0].table_name).toBe("large");
  });
});

// Test MetricsServer endpoints
describe("MetricsServer", () => {
  let server: MetricsServer;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    server = new MetricsServer("http://test-prometheus:9090", 9999);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("handleHealth returns healthy when prometheus is available", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200 })
      )
    );

    const response = await server.handleHealth();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe("healthy");
  });

  test("handleHealth returns unhealthy on error", async () => {
    global.fetch = mock(() => Promise.reject(new Error("Connection refused")));

    const response = await server.handleHealth();
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.status).toBe("unhealthy");
  });

  test("handlePgssMetrics requires time parameters", async () => {
    const url = new URL("http://localhost/pgss_metrics/csv");
    const response = await server.handlePgssMetrics(url);
    expect(response.status).toBe(400);
  });

  test("handlePgssMetrics returns CSV", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200 })
      )
    );

    const url = new URL("http://localhost/pgss_metrics/csv?time_start=1704067200&time_end=1704153600");
    const response = await server.handlePgssMetrics(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv");
  });

  test("handleBtreeBloat returns CSV", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200 })
      )
    );

    const url = new URL("http://localhost/btree_bloat/csv");
    const response = await server.handleBtreeBloat(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv");
  });

  test("handleTableInfo instant mode returns CSV", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200 })
      )
    );

    const url = new URL("http://localhost/table_info/csv");
    const response = await server.handleTableInfo(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("table_stats_latest.csv");
  });

  test("handleTableInfo rate mode returns CSV", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200 })
      )
    );

    const url = new URL("http://localhost/table_info/csv?time_start=1704067200&time_end=1704153600");
    const response = await server.handleTableInfo(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("table_stats_");
  });

  test("handleMetricsList returns pg_stat_statements metrics", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: "success",
            data: ["pgwatch_pg_stat_statements_calls", "other_metric"],
          }),
          { status: 200 }
        )
      )
    );

    const response = await server.handleMetricsList();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.pg_stat_statements_metrics).toContain("pgwatch_pg_stat_statements_calls");
    expect(data.pg_stat_statements_metrics).not.toContain("other_metric");
  });

  test("handleDebugMetrics returns btree metrics info", async () => {
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "success",
              data: ["pgwatch_pg_btree_bloat_real_size_mib"],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ status: "success", data: { result: [] } }),
          { status: 200 }
        )
      );
    });

    const response = await server.handleDebugMetrics();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.btree_metrics).toBeDefined();
  });

  test("handleRequest routes to correct handler", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200 })
      )
    );

    const healthReq = new Request("http://localhost/health");
    const healthResponse = await server.handleRequest(healthReq);
    expect(healthResponse.status).toBe(200);

    const notFoundReq = new Request("http://localhost/unknown");
    const notFoundResponse = await server.handleRequest(notFoundReq);
    expect(notFoundResponse.status).toBe(404);
  });
});

// Test PrometheusClient
describe("PrometheusClient", () => {
  let client: PrometheusClient;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    client = new PrometheusClient("http://test-prometheus:9090");
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("query sends correct request", async () => {
    let capturedUrl: string | undefined;
    global.fetch = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200 })
      );
    });

    await client.query("up");
    expect(capturedUrl).toContain("/api/v1/query");
    expect(capturedUrl).toContain("query=up");
  });

  test("queryRange sends correct request", async () => {
    let capturedUrl: string | undefined;
    global.fetch = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200 })
      );
    });

    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-02T00:00:00Z");
    await client.queryRange("up", start, end);

    expect(capturedUrl).toContain("/api/v1/query_range");
    expect(capturedUrl).toContain("query=up");
    expect(capturedUrl).toContain("start=");
    expect(capturedUrl).toContain("end=");
  });

  test("allMetrics returns metric names", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: ["metric1", "metric2"] }), {
          status: 200,
        })
      )
    );

    const metrics = await client.allMetrics();
    expect(metrics).toContain("metric1");
    expect(metrics).toContain("metric2");
  });

  test("testConnection returns true on success", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "success", data: { result: [] } }), { status: 200 })
      )
    );

    const result = await client.testConnection();
    expect(result).toBe(true);
  });

  test("testConnection returns false on error", async () => {
    global.fetch = mock(() => Promise.reject(new Error("Connection refused")));

    const result = await client.testConnection();
    expect(result).toBe(false);
  });

  test("query throws on HTTP error", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 }))
    );

    await expect(client.query("up")).rejects.toThrow();
  });
});
