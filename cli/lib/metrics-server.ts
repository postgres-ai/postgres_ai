/**
 * Metrics Server Module
 * =====================
 * HTTP server for exporting PostgreSQL metrics from VictoriaMetrics/Prometheus
 * as CSV files. This is the TypeScript/Bun port of the Python Flask backend.
 *
 * Endpoints:
 * - GET /health - Health check with Prometheus connectivity test
 * - GET /pgss_metrics/csv - pg_stat_statements metrics as CSV
 * - GET /btree_bloat/csv - B-tree bloat metrics as CSV
 * - GET /table_info/csv - Table statistics as CSV
 * - GET /metrics - List available metrics
 * - GET /debug/metrics - Debug endpoint for btree bloat metrics
 */

// Metric name mapping for cleaner CSV output
const METRIC_NAME_MAPPING: Record<string, string> = {
  calls: "calls",
  exec_time_total: "exec_time",
  plan_time_total: "plan_time",
  rows: "rows",
  shared_bytes_hit_total: "shared_blks_hit",
  shared_bytes_read_total: "shared_blks_read",
  shared_bytes_dirtied_total: "shared_blks_dirtied",
  shared_bytes_written_total: "shared_blks_written",
  block_read_total: "blk_read_time",
  block_write_total: "blk_write_time",
};

// pg_stat_statements metrics to query
const PGSS_METRICS = [
  "pgwatch_pg_stat_statements_calls",
  "pgwatch_pg_stat_statements_plans_total",
  "pgwatch_pg_stat_statements_exec_time_total",
  "pgwatch_pg_stat_statements_plan_time_total",
  "pgwatch_pg_stat_statements_rows",
  "pgwatch_pg_stat_statements_shared_bytes_hit_total",
  "pgwatch_pg_stat_statements_shared_bytes_read_total",
  "pgwatch_pg_stat_statements_shared_bytes_dirtied_total",
  "pgwatch_pg_stat_statements_shared_bytes_written_total",
  "pgwatch_pg_stat_statements_block_read_total",
  "pgwatch_pg_stat_statements_block_write_total",
  "pgwatch_pg_stat_statements_wal_records",
  "pgwatch_pg_stat_statements_wal_fpi",
  "pgwatch_pg_stat_statements_wal_bytes",
  "pgwatch_pg_stat_statements_temp_bytes_read",
  "pgwatch_pg_stat_statements_temp_bytes_written",
];

// Table metrics to query
const TABLE_BASE_METRICS: Record<string, string> = {
  total_size: "pgwatch_pg_class_total_relation_size_bytes",
  table_size: "pgwatch_table_size_detailed_table_main_size_b",
  index_size: "pgwatch_table_size_detailed_table_indexes_size_b",
  toast_size: "pgwatch_table_size_detailed_total_toast_size_b",
  seq_scan: "pgwatch_pg_stat_all_tables_seq_scan",
  idx_scan: "pgwatch_pg_stat_all_tables_idx_scan",
  n_tup_ins: "pgwatch_table_stats_n_tup_ins",
  n_tup_upd: "pgwatch_table_stats_n_tup_upd",
  n_tup_del: "pgwatch_table_stats_n_tup_del",
  n_tup_hot_upd: "pgwatch_table_stats_n_tup_hot_upd",
  heap_blks_read: "pgwatch_pg_statio_all_tables_heap_blks_read",
  heap_blks_hit: "pgwatch_pg_statio_all_tables_heap_blks_hit",
  idx_blks_read: "pgwatch_pg_statio_all_tables_idx_blks_read",
  idx_blks_hit: "pgwatch_pg_statio_all_tables_idx_blks_hit",
};

// Btree bloat metrics
const BTREE_BLOAT_METRICS = [
  "pgwatch_pg_btree_bloat_real_size_mib",
  "pgwatch_pg_btree_bloat_extra_size",
  "pgwatch_pg_btree_bloat_extra_pct",
  "pgwatch_pg_btree_bloat_fillfactor",
  "pgwatch_pg_btree_bloat_bloat_size",
  "pgwatch_pg_btree_bloat_bloat_pct",
  "pgwatch_pg_btree_bloat_is_na",
];

// Types for Prometheus responses
interface PrometheusMetric {
  __name__?: string;
  datname?: string;
  queryid?: string;
  user?: string;
  instance?: string;
  schemaname?: string;
  schema?: string;
  relname?: string;
  table_name?: string;
  tblname?: string;
  idxname?: string;
  cluster?: string;
  node_name?: string;
  [key: string]: string | undefined;
}

interface PrometheusValue {
  metric: PrometheusMetric;
  value?: [number, string];
  values?: [number, string][];
}

interface PrometheusResponse {
  status: string;
  data: {
    result: PrometheusValue[];
    resultType?: string;
  };
}

// Query key types
type PgssKey = [string, string, string, string]; // [datname, queryid, user, instance]
type TableKey = [string, string, string]; // [datname, schema, table_name]
type BtreeKey = [string, string, string, string]; // [datname, schema, table, index]

interface MetricDict {
  timestamp?: string;
  [key: string]: number | string | undefined;
}

/**
 * Parse time parameter (Unix timestamp or ISO format)
 */
export function parseTimeParam(timeStr: string): Date {
  // Check if it looks like a Unix timestamp (all digits, optionally with decimal)
  if (/^\d+(\.\d+)?$/.test(timeStr)) {
    const timestamp = parseFloat(timeStr);
    if (!isNaN(timestamp) && timestamp > 0) {
      return new Date(timestamp * 1000);
    }
  }
  // Try ISO format - pass directly to Date constructor
  const date = new Date(timeStr);
  if (!isNaN(date.getTime())) {
    return date;
  }
  throw new Error(`Invalid time format: ${timeStr}`);
}

/**
 * Format date for CSV filename
 */
function formatDateForFilename(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
}

/**
 * Convert array of objects to CSV string
 */
export function toCSV(data: Record<string, unknown>[], fields: string[]): string {
  if (data.length === 0) {
    return fields.join(",") + "\n";
  }

  const lines: string[] = [];
  lines.push(fields.join(","));

  for (const row of data) {
    const values = fields.map((field) => {
      const val = row[field];
      if (val === undefined || val === null) {
        return "";
      }
      const str = String(val);
      // Escape CSV special characters
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
    lines.push(values.join(","));
  }

  return lines.join("\n") + "\n";
}

/**
 * Prometheus client for querying metrics
 */
export class PrometheusClient {
  private baseUrl: string;

  constructor(prometheusUrl: string = "http://localhost:8428") {
    this.baseUrl = prometheusUrl.replace(/\/$/, "");
  }

  /**
   * Execute instant query
   */
  async query(queryStr: string): Promise<PrometheusResponse> {
    const url = new URL(`${this.baseUrl}/api/v1/query`);
    url.searchParams.set("query", queryStr);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Prometheus query failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<PrometheusResponse>;
  }

  /**
   * Execute range query
   */
  async queryRange(
    queryStr: string,
    start: Date,
    end: Date,
    step: string = "60s"
  ): Promise<PrometheusResponse> {
    const url = new URL(`${this.baseUrl}/api/v1/query_range`);
    url.searchParams.set("query", queryStr);
    url.searchParams.set("start", (start.getTime() / 1000).toString());
    url.searchParams.set("end", (end.getTime() / 1000).toString());
    url.searchParams.set("step", step);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Prometheus range query failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<PrometheusResponse>;
  }

  /**
   * Get all available metrics
   */
  async allMetrics(): Promise<string[]> {
    const url = new URL(`${this.baseUrl}/api/v1/label/__name__/values`);
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Failed to get metrics: ${response.status}`);
    }
    const data = (await response.json()) as { status: string; data: string[] };
    return data.data || [];
  }

  /**
   * Test connection
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.query("up");
      return result.status === "success";
    } catch {
      return false;
    }
  }
}

/**
 * Build filter string for Prometheus query
 */
function buildFilterString(filters: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      if (key === "schemaname") {
        // Support regex matching for schema
        parts.push(`${key}=~"${value}"`);
      } else if (key === "node_name" || key === "instance") {
        parts.push(`instance=~".*${value}.*"`);
      } else {
        parts.push(`${key}="${value}"`);
      }
    }
  }
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

/**
 * Convert Prometheus data to dictionary keyed by query identifiers (for PGSS)
 */
export function prometheusToPgssDict(
  promData: PrometheusValue[],
  targetTimestamp: Date
): Map<string, MetricDict> {
  const metricsDict = new Map<string, MetricDict>();

  for (const entry of promData) {
    const metric = entry.metric;
    const values = entry.values || (entry.value ? [[entry.value[0], entry.value[1]]] : []);

    if (values.length === 0) continue;

    // Find closest value to target timestamp
    const targetTs = targetTimestamp.getTime() / 1000;
    let closestValue = values[0];
    let minDiff = Math.abs(values[0][0] - targetTs);

    for (const val of values) {
      const diff = Math.abs(val[0] - targetTs);
      if (diff < minDiff) {
        minDiff = diff;
        closestValue = val;
      }
    }

    // Create unique key for this query
    const key = [
      metric.datname || "",
      metric.queryid || "",
      metric.user || "",
      metric.instance || "",
    ].join("|");

    if (!metricsDict.has(key)) {
      metricsDict.set(key, {
        timestamp: new Date(closestValue[0] * 1000).toISOString(),
      });
    }

    // Add metric value
    const metricName = (metric.__name__ || "pgwatch_pg_stat_statements_calls").replace(
      "pgwatch_pg_stat_statements_",
      ""
    );

    try {
      metricsDict.get(key)![metricName] = parseFloat(closestValue[1]);
    } catch {
      metricsDict.get(key)![metricName] = 0;
    }
  }

  return metricsDict;
}

/**
 * Convert Prometheus table data to dictionary
 */
export function prometheusTableToDict(
  promData: Map<string, PrometheusValue[]>,
  targetTimestamp: Date
): Map<string, MetricDict> {
  const metricsDict = new Map<string, MetricDict>();

  for (const [metricName, entries] of promData) {
    for (const entry of entries) {
      const metric = entry.metric;
      const values = entry.values || (entry.value ? [[entry.value[0], entry.value[1]]] : []);

      if (values.length === 0) continue;

      // Find closest value to target timestamp
      const targetTs = targetTimestamp.getTime() / 1000;
      let closestValue = values[0];
      let minDiff = Math.abs(values[0][0] - targetTs);

      for (const val of values) {
        const diff = Math.abs(val[0] - targetTs);
        if (diff < minDiff) {
          minDiff = diff;
          closestValue = val;
        }
      }

      // Handle different label names
      const schemaLabel = metric.schemaname || metric.schema || "";
      const tableLabel = metric.relname || metric.table_name || metric.tblname || "";

      const key = [metric.datname || "", schemaLabel, tableLabel].join("|");

      if (!metricsDict.has(key)) {
        metricsDict.set(key, {
          timestamp: new Date(closestValue[0] * 1000).toISOString(),
        });
      }

      try {
        metricsDict.get(key)![metricName] = parseFloat(closestValue[1]);
      } catch {
        metricsDict.get(key)![metricName] = 0;
      }
    }
  }

  return metricsDict;
}

/**
 * Process PGSS data and calculate differences
 */
export function processPgssData(
  startData: PrometheusValue[],
  endData: PrometheusValue[],
  startTime: Date,
  endTime: Date
): Record<string, unknown>[] {
  const startMetrics = prometheusToPgssDict(startData, startTime);
  const endMetrics = prometheusToPgssDict(endData, endTime);

  if (startMetrics.size === 0 && endMetrics.size === 0) {
    return [];
  }

  // Combine all keys
  const allKeys = new Set([...startMetrics.keys(), ...endMetrics.keys()]);
  const resultRows: Record<string, unknown>[] = [];

  for (const key of allKeys) {
    const startMetric = startMetrics.get(key) || {};
    const endMetric = endMetrics.get(key) || {};

    // Parse key
    const [dbName, queryId, user, instance] = key.split("|");

    // Calculate duration
    let actualDuration: number;
    if (startMetric.timestamp && endMetric.timestamp) {
      const startDt = new Date(startMetric.timestamp);
      const endDt = new Date(endMetric.timestamp);
      actualDuration = (endDt.getTime() - startDt.getTime()) / 1000;
    } else {
      actualDuration = (endTime.getTime() - startTime.getTime()) / 1000;
    }

    const row: Record<string, unknown> = {
      queryid: queryId,
      duration_seconds: actualDuration,
    };

    // Calculate differences and rates for each metric
    for (const [col, displayName] of Object.entries(METRIC_NAME_MAPPING)) {
      const startVal = (startMetric[col] as number) || 0;
      const endVal = (endMetric[col] as number) || 0;
      let diff = endVal - startVal;

      // Convert bytes to blocks for block-related metrics
      if (displayName.includes("blks") && col.includes("bytes")) {
        diff = diff / 8192;
      }

      row[displayName] = diff;

      // Calculate rate per second
      if (actualDuration > 0) {
        row[`${displayName}_per_sec`] = diff / actualDuration;
      } else {
        row[`${displayName}_per_sec`] = 0;
      }

      // Calculate per-call average
      const callsDiff = (row["calls"] as number) || 0;
      if (callsDiff > 0) {
        row[`${displayName}_per_call`] = diff / callsDiff;
      } else {
        row[`${displayName}_per_call`] = 0;
      }
    }

    resultRows.push(row);
  }

  // Sort by execution time descending
  resultRows.sort((a, b) => ((b.exec_time as number) || 0) - ((a.exec_time as number) || 0));

  return resultRows;
}

/**
 * Process table stats with rates
 */
export function processTableStatsWithRates(
  startData: Map<string, PrometheusValue[]>,
  endData: Map<string, PrometheusValue[]>,
  startTime: Date,
  endTime: Date
): Record<string, unknown>[] {
  const startMetrics = prometheusTableToDict(startData, startTime);
  const endMetrics = prometheusTableToDict(endData, endTime);

  if (startMetrics.size === 0 && endMetrics.size === 0) {
    return [];
  }

  const allKeys = new Set([...startMetrics.keys(), ...endMetrics.keys()]);
  const resultRows: Record<string, unknown>[] = [];

  const counterMetrics = [
    "seq_scan",
    "idx_scan",
    "n_tup_ins",
    "n_tup_upd",
    "n_tup_del",
    "n_tup_hot_upd",
    "heap_blks_read",
    "heap_blks_hit",
    "idx_blks_read",
    "idx_blks_hit",
  ];

  const displayNames: Record<string, string> = {
    seq_scan: "seq_scans",
    idx_scan: "idx_scans",
    n_tup_ins: "inserts",
    n_tup_upd: "updates",
    n_tup_del: "deletes",
    n_tup_hot_upd: "hot_updates",
  };

  for (const key of allKeys) {
    const startMetric = startMetrics.get(key) || {};
    const endMetric = endMetrics.get(key) || {};

    const [dbName, schemaName, tableName] = key.split("|");

    // Calculate duration
    let actualDuration: number;
    if (startMetric.timestamp && endMetric.timestamp) {
      const startDt = new Date(startMetric.timestamp);
      const endDt = new Date(endMetric.timestamp);
      actualDuration = (endDt.getTime() - startDt.getTime()) / 1000;
    } else {
      actualDuration = (endTime.getTime() - startTime.getTime()) / 1000;
    }

    const row: Record<string, unknown> = {
      schema: schemaName,
      table_name: tableName,
      duration_seconds: actualDuration,
    };

    // Calculate differences and rates for counter metrics
    for (const metric of counterMetrics) {
      const startVal = (startMetric[metric] as number) || 0;
      const endVal = (endMetric[metric] as number) || 0;
      const diff = endVal - startVal;

      const displayName = displayNames[metric] || metric;
      row[displayName] = diff;

      if (actualDuration > 0) {
        row[`${displayName}_per_sec`] = diff / actualDuration;
      } else {
        row[`${displayName}_per_sec`] = 0;
      }
    }

    // Size metrics (just use end values)
    for (const sizeMetric of ["total_size", "table_size", "index_size", "toast_size"]) {
      row[sizeMetric] = (endMetric[sizeMetric] as number) || 0;
    }

    resultRows.push(row);
  }

  // Sort by total size descending
  resultRows.sort((a, b) => ((b.total_size as number) || 0) - ((a.total_size as number) || 0));

  return resultRows;
}

/**
 * Metrics Server
 */
export class MetricsServer {
  private prometheus: PrometheusClient;
  private port: number;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(prometheusUrl: string = "http://localhost:8428", port: number = 8000) {
    this.prometheus = new PrometheusClient(prometheusUrl);
    this.port = port;
  }

  /**
   * Handle health check
   */
  async handleHealth(): Promise<Response> {
    try {
      const healthy = await this.prometheus.testConnection();
      if (healthy) {
        return Response.json({
          status: "healthy",
          prometheus_url: this.prometheus["baseUrl"],
        });
      }
      return Response.json({ status: "unhealthy", error: "Prometheus connection failed" }, { status: 500 });
    } catch (error) {
      return Response.json(
        { status: "unhealthy", error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Handle PGSS metrics endpoint
   */
  async handlePgssMetrics(url: URL): Promise<Response> {
    try {
      const timeStart = url.searchParams.get("time_start");
      const timeEnd = url.searchParams.get("time_end");

      if (!timeStart || !timeEnd) {
        return Response.json(
          { error: "time_start and time_end parameters are required" },
          { status: 400 }
        );
      }

      const startDt = parseTimeParam(timeStart);
      const endDt = parseTimeParam(timeEnd);

      const filters = buildFilterString({
        cluster: url.searchParams.get("cluster_name") || undefined,
        datname: url.searchParams.get("db_name") || undefined,
        instance: url.searchParams.get("node_name") || undefined,
      });

      // Query metrics at start and end times
      const startData: PrometheusValue[] = [];
      const endData: PrometheusValue[] = [];

      for (const metric of PGSS_METRICS) {
        const queryStr = filters ? `${metric}${filters}` : metric;
        try {
          // Query around start time
          const startResult = await this.prometheus.queryRange(
            queryStr,
            new Date(startDt.getTime() - 60000),
            new Date(startDt.getTime() + 60000)
          );
          startData.push(...startResult.data.result);

          // Query around end time
          const endResult = await this.prometheus.queryRange(
            queryStr,
            new Date(endDt.getTime() - 60000),
            new Date(endDt.getTime() + 60000)
          );
          endData.push(...endResult.data.result);
        } catch (err) {
          console.warn(`Failed to query metric ${metric}:`, err);
        }
      }

      // Process data
      const csvData = processPgssData(startData, endData, startDt, endDt);

      // Build CSV
      const baseFields = ["queryid", "duration_seconds"];
      const metricFields: string[] = [];
      const desiredOrder = [
        "calls",
        "exec_time",
        "plan_time",
        "rows",
        "shared_blks_hit",
        "shared_blks_read",
        "shared_blks_dirtied",
        "shared_blks_written",
        "blk_read_time",
        "blk_write_time",
      ];

      for (const displayName of desiredOrder) {
        if (Object.values(METRIC_NAME_MAPPING).includes(displayName)) {
          metricFields.push(displayName, `${displayName}_per_sec`, `${displayName}_per_call`);
        }
      }

      const csvContent = toCSV(csvData, [...baseFields, ...metricFields]);
      const filename = `pgss_metrics_${formatDateForFilename(startDt)}_${formatDateForFilename(endDt)}.csv`;

      return new Response(csvContent, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename=${filename}`,
        },
      });
    } catch (error) {
      console.error("Error processing PGSS metrics request:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Handle btree bloat endpoint
   */
  async handleBtreeBloat(url: URL): Promise<Response> {
    try {
      const filters = buildFilterString({
        cluster: url.searchParams.get("cluster_name") || undefined,
        node_name: url.searchParams.get("node_name") || undefined,
        datname: url.searchParams.get("db_name") || undefined,
        schemaname: url.searchParams.get("schemaname") || undefined,
        tblname: url.searchParams.get("tblname") || undefined,
        idxname: url.searchParams.get("idxname") || undefined,
      });

      const metricResults = new Map<string, Record<string, unknown>>();

      for (const metric of BTREE_BLOAT_METRICS) {
        const query = `last_over_time(${metric}${filters}[1d])`;
        try {
          const result = await this.prometheus.query(query);

          for (const entry of result.data.result) {
            const labels = entry.metric;
            const key = [
              labels.datname || "",
              labels.schemaname || "",
              labels.tblname || "",
              labels.idxname || "",
            ].join("|");

            if (!metricResults.has(key)) {
              metricResults.set(key, {
                database: labels.datname || "",
                schemaname: labels.schemaname || "",
                tblname: labels.tblname || "",
                idxname: labels.idxname || "",
              });
            }

            const value = entry.value ? parseFloat(entry.value[1]) : 0;

            if (metric.includes("real_size_mib")) {
              metricResults.get(key)!.real_size_mib = value;
            } else if (metric.includes("extra_size") && !metric.includes("extra_pct")) {
              metricResults.get(key)!.extra_size = value;
            } else if (metric.includes("extra_pct")) {
              metricResults.get(key)!.extra_pct = value;
            } else if (metric.includes("fillfactor")) {
              metricResults.get(key)!.fillfactor = value;
            } else if (metric.includes("bloat_size")) {
              metricResults.get(key)!.bloat_size = value;
            } else if (metric.includes("bloat_pct")) {
              metricResults.get(key)!.bloat_pct = value;
            } else if (metric.includes("is_na")) {
              metricResults.get(key)!.is_na = Math.round(value);
            }
          }
        } catch (err) {
          console.warn(`Failed to query ${metric}:`, err);
        }
      }

      const fields = [
        "database",
        "schemaname",
        "tblname",
        "idxname",
        "real_size_mib",
        "extra_size",
        "extra_pct",
        "fillfactor",
        "bloat_size",
        "bloat_pct",
        "is_na",
      ];

      const csvContent = toCSV([...metricResults.values()], fields);

      return new Response(csvContent, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=btree_bloat_latest.csv",
        },
      });
    } catch (error) {
      console.error("Error processing btree bloat request:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Handle table info endpoint
   */
  async handleTableInfo(url: URL): Promise<Response> {
    try {
      const timeStart = url.searchParams.get("time_start");
      const timeEnd = url.searchParams.get("time_end");
      const calculateRates = Boolean(timeStart && timeEnd);

      const filters = buildFilterString({
        cluster: url.searchParams.get("cluster_name") || undefined,
        node_name: url.searchParams.get("node_name") || undefined,
        datname: url.searchParams.get("db_name") || undefined,
        schemaname: url.searchParams.get("schemaname") || undefined,
        tblname: url.searchParams.get("tblname") || undefined,
      });

      let metricResults: Record<string, unknown>[] | Map<string, Record<string, unknown>>;

      if (calculateRates) {
        const startDt = parseTimeParam(timeStart!);
        const endDt = parseTimeParam(timeEnd!);

        const startData = new Map<string, PrometheusValue[]>();
        const endData = new Map<string, PrometheusValue[]>();

        for (const [metricName, metricQuery] of Object.entries(TABLE_BASE_METRICS)) {
          const queryStr = filters ? `${metricQuery}${filters}` : metricQuery;
          try {
            const startResult = await this.prometheus.queryRange(
              queryStr,
              new Date(startDt.getTime() - 60000),
              new Date(startDt.getTime() + 60000)
            );
            startData.set(metricName, startResult.data.result);

            const endResult = await this.prometheus.queryRange(
              queryStr,
              new Date(endDt.getTime() - 60000),
              new Date(endDt.getTime() + 60000)
            );
            endData.set(metricName, endResult.data.result);
          } catch (err) {
            console.warn(`Failed to query metric ${metricName}:`, err);
          }
        }

        metricResults = processTableStatsWithRates(startData, endData, startDt, endDt);

        const fields = [
          "schema",
          "table_name",
          "total_size",
          "table_size",
          "index_size",
          "toast_size",
          "seq_scans",
          "seq_scans_per_sec",
          "idx_scans",
          "idx_scans_per_sec",
          "inserts",
          "inserts_per_sec",
          "updates",
          "updates_per_sec",
          "deletes",
          "deletes_per_sec",
          "hot_updates",
          "hot_updates_per_sec",
          "heap_blks_read",
          "heap_blks_read_per_sec",
          "heap_blks_hit",
          "heap_blks_hit_per_sec",
          "idx_blks_read",
          "idx_blks_read_per_sec",
          "idx_blks_hit",
          "idx_blks_hit_per_sec",
          "duration_seconds",
        ];

        const csvContent = toCSV(metricResults, fields);
        const filename = `table_stats_${formatDateForFilename(startDt)}_${formatDateForFilename(endDt)}.csv`;

        return new Response(csvContent, {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": `attachment; filename=${filename}`,
          },
        });
      } else {
        // Instant query mode
        metricResults = new Map<string, Record<string, unknown>>();

        for (const [metricName, metricQuery] of Object.entries(TABLE_BASE_METRICS)) {
          const query = `last_over_time(${metricQuery}${filters}[1d])`;
          try {
            const result = await this.prometheus.query(query);

            for (const entry of result.data.result) {
              const labels = entry.metric;
              const schemaLabel = labels.schemaname || labels.schema || "";
              const tableLabel = labels.relname || labels.table_name || labels.tblname || "";

              const key = [labels.datname || "", schemaLabel, tableLabel].join("|");

              if (!metricResults.has(key)) {
                metricResults.set(key, {
                  schema: schemaLabel,
                  table_name: tableLabel,
                });
              }

              const value = entry.value ? parseFloat(entry.value[1]) : 0;
              metricResults.get(key)![metricName] = value;
            }
          } catch (err) {
            console.warn(`Failed to query metric ${metricName}:`, err);
          }
        }

        const fields = [
          "schema",
          "table_name",
          "total_size",
          "table_size",
          "index_size",
          "toast_size",
          "seq_scan",
          "idx_scan",
          "n_tup_ins",
          "n_tup_upd",
          "n_tup_del",
          "n_tup_hot_upd",
          "heap_blks_read",
          "heap_blks_hit",
          "idx_blks_read",
          "idx_blks_hit",
        ];

        const csvContent = toCSV([...metricResults.values()], fields);

        return new Response(csvContent, {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": "attachment; filename=table_stats_latest.csv",
          },
        });
      }
    } catch (error) {
      console.error("Error processing table info request:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Handle metrics list endpoint
   */
  async handleMetricsList(): Promise<Response> {
    try {
      const allMetrics = await this.prometheus.allMetrics();
      const pgssMetrics = allMetrics.filter((m) => m.includes("pg_stat_statements"));
      return Response.json({ pg_stat_statements_metrics: pgssMetrics });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Handle debug metrics endpoint
   */
  async handleDebugMetrics(): Promise<Response> {
    try {
      const allMetrics = await this.prometheus.allMetrics();
      const btreeMetrics = allMetrics.filter((m) => m.includes("btree_bloat"));

      const sampleData: Record<string, unknown> = {};
      for (const metric of btreeMetrics.slice(0, 5)) {
        try {
          const result = await this.prometheus.query(metric);
          sampleData[metric] = {
            count: result.data.result.length,
            sample_labels: result.data.result.slice(0, 2).map((entry) => entry.metric),
          };
        } catch (err) {
          sampleData[metric] = { error: String(err) };
        }
      }

      return Response.json({
        all_metrics_count: allMetrics.length,
        btree_metrics: btreeMetrics,
        sample_data: sampleData,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Main request handler
   */
  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      switch (path) {
        case "/health":
          return await this.handleHealth();
        case "/pgss_metrics/csv":
          return await this.handlePgssMetrics(url);
        case "/btree_bloat/csv":
          return await this.handleBtreeBloat(url);
        case "/table_info/csv":
          return await this.handleTableInfo(url);
        case "/metrics":
          return await this.handleMetricsList();
        case "/debug/metrics":
          return await this.handleDebugMetrics();
        default:
          return Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (error) {
      console.error("Request handler error:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }

  /**
   * Start the server
   */
  start(): void {
    this.server = Bun.serve({
      port: this.port,
      fetch: (req) => this.handleRequest(req),
    });
    console.log(`Metrics server listening on http://localhost:${this.port}`);
  }

  /**
   * Stop the server
   */
  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }
}

// CLI entrypoint
if (import.meta.main) {
  const prometheusUrl = process.env.PROMETHEUS_URL || "http://localhost:8428";
  const port = parseInt(process.env.PORT || "8000", 10);

  const server = new MetricsServer(prometheusUrl, port);
  server.start();
}
