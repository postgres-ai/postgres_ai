/**
 * PostgreSQL Reporter Module
 * ==========================
 * Generates JSON health check reports from Prometheus/VictoriaMetrics metrics.
 * This is the TypeScript/Bun port of the Python reporter.
 *
 * The reporter queries Prometheus for PostgreSQL metrics collected by pgwatch
 * and generates standardized JSON reports for various health checks.
 *
 * Check Types:
 * - A002: PostgreSQL version
 * - A003: PostgreSQL settings
 * - A004: Cluster information
 * - A007: Altered settings
 * - D004: pg_stat_statements settings
 * - F001: Autovacuum settings
 * - F004: Heap bloat
 * - F005: Btree bloat
 * - G001: Memory settings
 * - H001: Invalid indexes
 * - H002: Unused indexes
 * - H004: Redundant indexes
 * - K001-K008: Query performance metrics
 * - M001-M003: Query timing metrics
 * - N001: Wait events
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import * as pkg from "../package.json";
import { PrometheusClient } from "./metrics-server";

// Version for reports
const REPORTER_VERSION = "1.0.0";

// Settings filter lists
const D004_SETTINGS = [
  "pg_stat_statements.max",
  "pg_stat_statements.track",
  "pg_stat_statements.track_utility",
  "pg_stat_statements.save",
  "pg_stat_statements.track_planning",
  "shared_preload_libraries",
  "track_activities",
  "track_counts",
  "track_functions",
  "track_io_timing",
  "track_wal_io_timing",
];

const F001_SETTINGS = [
  "autovacuum",
  "autovacuum_analyze_scale_factor",
  "autovacuum_analyze_threshold",
  "autovacuum_freeze_max_age",
  "autovacuum_max_workers",
  "autovacuum_multixact_freeze_max_age",
  "autovacuum_naptime",
  "autovacuum_vacuum_cost_delay",
  "autovacuum_vacuum_cost_limit",
  "autovacuum_vacuum_insert_scale_factor",
  "autovacuum_vacuum_scale_factor",
  "autovacuum_vacuum_threshold",
  "autovacuum_work_mem",
  "vacuum_cost_delay",
  "vacuum_cost_limit",
  "vacuum_cost_page_dirty",
  "vacuum_cost_page_hit",
  "vacuum_cost_page_miss",
  "vacuum_freeze_min_age",
  "vacuum_freeze_table_age",
  "vacuum_multixact_freeze_min_age",
  "vacuum_multixact_freeze_table_age",
];

const G001_SETTINGS = [
  "shared_buffers",
  "work_mem",
  "maintenance_work_mem",
  "effective_cache_size",
  "autovacuum_work_mem",
  "max_wal_size",
  "min_wal_size",
  "wal_buffers",
  "checkpoint_completion_target",
  "max_connections",
  "max_prepared_transactions",
  "max_locks_per_transaction",
  "max_pred_locks_per_transaction",
  "max_pred_locks_per_relation",
  "max_pred_locks_per_page",
  "logical_decoding_work_mem",
  "hash_mem_multiplier",
  "temp_buffers",
  "shared_preload_libraries",
  "dynamic_shared_memory_type",
  "huge_pages",
  "max_files_per_process",
  "max_stack_depth",
];

// Default excluded databases
const DEFAULT_EXCLUDED_DATABASES = new Set([
  "template0",
  "template1",
  "rdsadmin",
  "azure_maintenance",
  "cloudsqladmin",
]);

// Types
interface PrometheusMetric {
  __name__?: string;
  cluster?: string;
  instance?: string;
  datname?: string;
  [key: string]: string | undefined;
}

interface PrometheusValue {
  metric: PrometheusMetric;
  value?: [number, string];
  values?: [number, string][];
}

interface BuildMetadata {
  version: string;
  build_ts: string | null;
}

export interface ReportNode {
  data: Record<string, unknown>;
  postgres_version?: {
    version: string;
    server_version_num: string;
    server_major_ver: string;
    server_minor_ver: string;
  };
}

export interface Report {
  version: string;
  build_ts: string | null;
  generation_mode: string;
  checkId: string;
  checkTitle: string;
  timestamptz: string;
  nodes: {
    primary: string;
    standbys: string[];
  };
  results: Record<string, ReportNode>;
}

/**
 * Read text file safely
 */
function readTextFileSafe(p: string): string | null {
  try {
    const value = fs.readFileSync(p, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Load build metadata
 */
function loadBuildMetadata(): BuildMetadata {
  const envPath = process.env.PGAI_BUILD_TS_FILE;
  const p = envPath && envPath.trim() ? envPath.trim() : "/BUILD_TS";

  let buildTs = readTextFileSafe(p);
  if (!buildTs) {
    try {
      const pkgRoot = path.resolve(__dirname, "..");
      buildTs = readTextFileSafe(path.join(pkgRoot, "BUILD_TS"));
    } catch {
      // Ignore
    }
  }
  if (!buildTs) {
    try {
      const pkgJsonPath = path.resolve(__dirname, "..", "package.json");
      const st = fs.statSync(pkgJsonPath);
      buildTs = st.mtime.toISOString();
    } catch {
      buildTs = new Date().toISOString();
    }
  }

  return {
    version: pkg.version || REPORTER_VERSION,
    build_ts: buildTs,
  };
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 0) return `-${formatBytes(-bytes)}`;
  if (!Number.isFinite(bytes)) return `${bytes} B`;
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * PostgreSQL Report Generator
 */
export class PostgresReportGenerator {
  private prometheus: PrometheusClient;
  private postgresSinkUrl: string;
  private pgConn: Client | null = null;
  private buildMetadata: BuildMetadata;
  private excludedDatabases: Set<string>;

  constructor(
    prometheusUrl: string = "http://sink-prometheus:9090",
    postgresSinkUrl: string = "postgresql://pgwatch@sink-postgres:5432/measurements",
    excludedDatabases?: string[]
  ) {
    this.prometheus = new PrometheusClient(prometheusUrl);
    this.postgresSinkUrl = postgresSinkUrl;
    this.buildMetadata = loadBuildMetadata();
    this.excludedDatabases = new Set([...DEFAULT_EXCLUDED_DATABASES, ...(excludedDatabases || [])]);
  }

  /**
   * Test Prometheus connection
   */
  async testConnection(): Promise<boolean> {
    return this.prometheus.testConnection();
  }

  /**
   * Get all clusters from Prometheus
   */
  async getAllClusters(): Promise<string[]> {
    try {
      const result = await this.prometheus.query("group by (cluster)(pgwatch_pg_settings)");
      const clusters: string[] = [];
      for (const entry of result.data.result) {
        if (entry.metric.cluster) {
          clusters.push(entry.metric.cluster);
        }
      }
      return clusters.sort();
    } catch (error) {
      console.error("Error getting clusters:", error);
      return [];
    }
  }

  /**
   * Get all nodes for a cluster
   */
  async getAllNodes(cluster: string): Promise<string[]> {
    try {
      const result = await this.prometheus.query(
        `group by (instance)(pgwatch_pg_settings{cluster="${cluster}"})`
      );
      const nodes: string[] = [];
      for (const entry of result.data.result) {
        if (entry.metric.instance) {
          nodes.push(entry.metric.instance);
        }
      }
      return nodes.sort();
    } catch (error) {
      console.error("Error getting nodes:", error);
      return [];
    }
  }

  /**
   * Get all databases for a cluster/node
   */
  async getAllDatabases(cluster: string, nodeName?: string): Promise<string[]> {
    try {
      const nodeFilter = nodeName ? `,instance="${nodeName}"` : "";
      const result = await this.prometheus.query(
        `group by (datname)(pgwatch_db_stats{cluster="${cluster}"${nodeFilter}})`
      );
      const databases: string[] = [];
      for (const entry of result.data.result) {
        if (entry.metric.datname && !this.excludedDatabases.has(entry.metric.datname)) {
          databases.push(entry.metric.datname);
        }
      }
      return databases.sort();
    } catch (error) {
      console.error("Error getting databases:", error);
      return [];
    }
  }

  /**
   * Create base report structure
   */
  createBaseReport(checkId: string, checkTitle: string, nodeName: string): Report {
    return {
      version: this.buildMetadata.version,
      build_ts: this.buildMetadata.build_ts,
      generation_mode: "full",
      checkId,
      checkTitle,
      timestamptz: new Date().toISOString(),
      nodes: {
        primary: nodeName,
        standbys: [],
      },
      results: {},
    };
  }

  /**
   * Query Prometheus instant
   */
  async queryInstant(query: string): Promise<PrometheusValue[]> {
    try {
      const result = await this.prometheus.query(query);
      return result.data.result;
    } catch (error) {
      console.error(`Prometheus query error for "${query}":`, error);
      return [];
    }
  }

  /**
   * Query Prometheus range
   */
  async queryRange(
    query: string,
    startTime: Date,
    endTime: Date,
    step: string = "60s"
  ): Promise<PrometheusValue[]> {
    try {
      const result = await this.prometheus.queryRange(query, startTime, endTime, step);
      return result.data.result;
    } catch (error) {
      console.error(`Prometheus range query error for "${query}":`, error);
      return [];
    }
  }

  /**
   * Get PostgreSQL version from Prometheus
   */
  async getPostgresVersion(cluster: string, nodeName?: string): Promise<Record<string, unknown>> {
    const nodeFilter = nodeName ? `,instance=~".*${nodeName}.*"` : "";
    const query = `pgwatch_pg_settings{cluster="${cluster}"${nodeFilter},tag_setting_name="server_version"}`;
    const result = await this.queryInstant(query);

    let version = "";
    let versionNum = "";

    for (const entry of result) {
      if (entry.metric.tag_setting_name === "server_version") {
        version = entry.metric.tag_setting_value || "";
      }
    }

    // Get version number
    const queryNum = `pgwatch_pg_settings{cluster="${cluster}"${nodeFilter},tag_setting_name="server_version_num"}`;
    const resultNum = await this.queryInstant(queryNum);

    for (const entry of resultNum) {
      if (entry.metric.tag_setting_name === "server_version_num") {
        versionNum = entry.metric.tag_setting_value || "";
      }
    }

    // Parse version number
    let major = "";
    let minor = "";
    if (versionNum && versionNum.length >= 6) {
      try {
        const num = parseInt(versionNum, 10);
        major = Math.floor(num / 10000).toString();
        minor = (num % 10000).toString();
      } catch {
        // Ignore
      }
    }

    return {
      version,
      server_version_num: versionNum,
      server_major_ver: major,
      server_minor_ver: minor,
    };
  }

  /**
   * Generate A002 - PostgreSQL major version report
   */
  async generateA002Report(cluster: string, nodeName: string = "node-01"): Promise<Report> {
    const report = this.createBaseReport("A002", "Postgres major version", nodeName);
    const version = await this.getPostgresVersion(cluster, nodeName);

    report.results[nodeName] = {
      data: { version },
    };

    return report;
  }

  /**
   * Get settings from Prometheus
   */
  async getSettings(
    cluster: string,
    nodeName?: string,
    filter?: string[]
  ): Promise<Record<string, unknown>> {
    const nodeFilter = nodeName ? `,instance=~".*${nodeName}.*"` : "";
    const query = `pgwatch_pg_settings{cluster="${cluster}"${nodeFilter}}`;
    const result = await this.queryInstant(query);

    const settings: Record<string, unknown> = {};

    for (const entry of result) {
      const name = entry.metric.tag_setting_name;
      if (!name) continue;

      // Apply filter if provided
      if (filter && !filter.includes(name)) continue;

      const value = entry.metric.tag_setting_value || "";
      const unit = entry.metric.tag_unit || "";
      const category = entry.metric.tag_category || "";
      const vartype = entry.metric.tag_vartype || "";

      settings[name] = {
        setting: value,
        unit,
        category,
        context: "",
        vartype,
        pretty_value: value,
      };
    }

    return settings;
  }

  /**
   * Generate A003 - PostgreSQL settings report
   */
  async generateA003Report(cluster: string, nodeName: string = "node-01"): Promise<Report> {
    const report = this.createBaseReport("A003", "Postgres settings", nodeName);
    const version = await this.getPostgresVersion(cluster, nodeName);
    const settings = await this.getSettings(cluster, nodeName);

    report.results[nodeName] = {
      data: settings,
      postgres_version: version as ReportNode["postgres_version"],
    };

    return report;
  }

  /**
   * Get altered (non-default) settings
   */
  async getAlteredSettings(cluster: string, nodeName?: string): Promise<Record<string, unknown>> {
    const nodeFilter = nodeName ? `,instance=~".*${nodeName}.*"` : "";
    const query = `pgwatch_pg_settings{cluster="${cluster}"${nodeFilter},is_default="0"}`;
    const result = await this.queryInstant(query);

    const settings: Record<string, unknown> = {};

    for (const entry of result) {
      const name = entry.metric.tag_setting_name;
      if (!name) continue;

      const value = entry.metric.tag_setting_value || "";
      const unit = entry.metric.tag_unit || "";
      const category = entry.metric.tag_category || "";

      settings[name] = {
        value,
        unit,
        category,
        pretty_value: value,
      };
    }

    return settings;
  }

  /**
   * Generate A007 - Altered settings report
   */
  async generateA007Report(cluster: string, nodeName: string = "node-01"): Promise<Report> {
    const report = this.createBaseReport("A007", "Altered settings", nodeName);
    const version = await this.getPostgresVersion(cluster, nodeName);
    const settings = await this.getAlteredSettings(cluster, nodeName);

    report.results[nodeName] = {
      data: settings,
      postgres_version: version as ReportNode["postgres_version"],
    };

    return report;
  }

  /**
   * Generate D004 - pg_stat_statements settings report
   */
  async generateD004Report(cluster: string, nodeName: string = "node-01"): Promise<Report> {
    const report = this.createBaseReport(
      "D004",
      "pg_stat_statements and pg_stat_kcache settings",
      nodeName
    );
    const version = await this.getPostgresVersion(cluster, nodeName);
    const settings = await this.getSettings(cluster, nodeName, D004_SETTINGS);

    report.results[nodeName] = {
      data: settings,
      postgres_version: version as ReportNode["postgres_version"],
    };

    return report;
  }

  /**
   * Generate F001 - Autovacuum settings report
   */
  async generateF001Report(cluster: string, nodeName: string = "node-01"): Promise<Report> {
    const report = this.createBaseReport("F001", "Autovacuum: current settings", nodeName);
    const version = await this.getPostgresVersion(cluster, nodeName);
    const settings = await this.getSettings(cluster, nodeName, F001_SETTINGS);

    report.results[nodeName] = {
      data: settings,
      postgres_version: version as ReportNode["postgres_version"],
    };

    return report;
  }

  /**
   * Generate G001 - Memory settings report
   */
  async generateG001Report(cluster: string, nodeName: string = "node-01"): Promise<Report> {
    const report = this.createBaseReport("G001", "Memory-related settings", nodeName);
    const version = await this.getPostgresVersion(cluster, nodeName);
    const settings = await this.getSettings(cluster, nodeName, G001_SETTINGS);

    report.results[nodeName] = {
      data: settings,
      postgres_version: version as ReportNode["postgres_version"],
    };

    return report;
  }

  /**
   * Get heap bloat data from Prometheus
   */
  async getHeapBloat(cluster: string, nodeName?: string): Promise<Record<string, unknown>[]> {
    const nodeFilter = nodeName ? `,instance=~".*${nodeName}.*"` : "";
    const query = `pgwatch_pg_table_bloat_approx_tbl_wasted_pct{cluster="${cluster}"${nodeFilter}} > 20`;
    const result = await this.queryInstant(query);

    const bloatData: Record<string, unknown>[] = [];

    for (const entry of result) {
      const value = entry.value ? parseFloat(entry.value[1]) : 0;
      if (this.excludedDatabases.has(entry.metric.datname || "")) continue;

      bloatData.push({
        database: entry.metric.datname || "",
        schemaname: entry.metric.schemaname || "",
        tablename: entry.metric.tablename || "",
        bloat_pct: value,
      });
    }

    return bloatData.sort((a, b) => (b.bloat_pct as number) - (a.bloat_pct as number));
  }

  /**
   * Generate F004 - Heap bloat report
   */
  async generateF004Report(cluster: string, nodeName: string = "node-01"): Promise<Report> {
    const report = this.createBaseReport("F004", "Heap bloat", nodeName);
    const version = await this.getPostgresVersion(cluster, nodeName);
    const bloatData = await this.getHeapBloat(cluster, nodeName);

    // Group by database
    const byDatabase: Record<string, unknown[]> = {};
    for (const entry of bloatData) {
      const db = entry.database as string;
      if (!byDatabase[db]) {
        byDatabase[db] = [];
      }
      byDatabase[db].push(entry);
    }

    report.results[nodeName] = {
      data: byDatabase,
      postgres_version: version as ReportNode["postgres_version"],
    };

    return report;
  }

  /**
   * Get btree bloat data from Prometheus
   */
  async getBtreeBloat(cluster: string, nodeName?: string): Promise<Record<string, unknown>[]> {
    const nodeFilter = nodeName ? `,instance=~".*${nodeName}.*"` : "";
    const query = `pgwatch_pg_btree_bloat_bloat_pct{cluster="${cluster}"${nodeFilter}} > 20`;
    const result = await this.queryInstant(query);

    const bloatData: Record<string, unknown>[] = [];

    for (const entry of result) {
      const value = entry.value ? parseFloat(entry.value[1]) : 0;
      if (this.excludedDatabases.has(entry.metric.datname || "")) continue;

      bloatData.push({
        database: entry.metric.datname || "",
        schemaname: entry.metric.schemaname || "",
        tablename: entry.metric.tblname || "",
        idxname: entry.metric.idxname || "",
        bloat_pct: value,
      });
    }

    return bloatData.sort((a, b) => (b.bloat_pct as number) - (a.bloat_pct as number));
  }

  /**
   * Generate F005 - Btree bloat report
   */
  async generateF005Report(cluster: string, nodeName: string = "node-01"): Promise<Report> {
    const report = this.createBaseReport("F005", "Btree bloat", nodeName);
    const version = await this.getPostgresVersion(cluster, nodeName);
    const bloatData = await this.getBtreeBloat(cluster, nodeName);

    // Group by database
    const byDatabase: Record<string, unknown[]> = {};
    for (const entry of bloatData) {
      const db = entry.database as string;
      if (!byDatabase[db]) {
        byDatabase[db] = [];
      }
      byDatabase[db].push(entry);
    }

    report.results[nodeName] = {
      data: byDatabase,
      postgres_version: version as ReportNode["postgres_version"],
    };

    return report;
  }

  /**
   * Get invalid indexes from Prometheus
   */
  async getInvalidIndexes(cluster: string, nodeName?: string): Promise<Record<string, unknown>[]> {
    const nodeFilter = nodeName ? `,instance=~".*${nodeName}.*"` : "";
    const query = `pgwatch_invalid_indexes_count{cluster="${cluster}"${nodeFilter}} > 0`;
    const result = await this.queryInstant(query);

    const indexes: Record<string, unknown>[] = [];

    for (const entry of result) {
      if (this.excludedDatabases.has(entry.metric.datname || "")) continue;

      indexes.push({
        database: entry.metric.datname || "",
        schemaname: entry.metric.schemaname || "",
        tablename: entry.metric.tablename || "",
        indexname: entry.metric.indexname || "",
      });
    }

    return indexes;
  }

  /**
   * Generate H001 - Invalid indexes report
   */
  async generateH001Report(cluster: string, nodeName: string = "node-01"): Promise<Report> {
    const report = this.createBaseReport("H001", "Invalid indexes", nodeName);
    const version = await this.getPostgresVersion(cluster, nodeName);
    const indexes = await this.getInvalidIndexes(cluster, nodeName);

    // Group by database
    const byDatabase: Record<string, unknown> = {};
    for (const entry of indexes) {
      const db = entry.database as string;
      if (!byDatabase[db]) {
        byDatabase[db] = {
          invalid_indexes: [],
          total_count: 0,
        };
      }
      (byDatabase[db] as Record<string, unknown[]>).invalid_indexes.push(entry);
      (byDatabase[db] as Record<string, number>).total_count++;
    }

    report.results[nodeName] = {
      data: byDatabase,
      postgres_version: version as ReportNode["postgres_version"],
    };

    return report;
  }

  /**
   * Get unused indexes from Prometheus
   */
  async getUnusedIndexes(cluster: string, nodeName?: string): Promise<Record<string, unknown>[]> {
    const nodeFilter = nodeName ? `,instance=~".*${nodeName}.*"` : "";
    const query = `pgwatch_unused_indexes_idx_scan_count{cluster="${cluster}"${nodeFilter}} == 0`;
    const result = await this.queryInstant(query);

    const indexes: Record<string, unknown>[] = [];

    for (const entry of result) {
      if (this.excludedDatabases.has(entry.metric.datname || "")) continue;

      indexes.push({
        database: entry.metric.datname || "",
        schemaname: entry.metric.schemaname || "",
        tablename: entry.metric.tablename || "",
        indexname: entry.metric.indexname || "",
        idx_scan: 0,
      });
    }

    return indexes;
  }

  /**
   * Generate H002 - Unused indexes report
   */
  async generateH002Report(cluster: string, nodeName: string = "node-01"): Promise<Report> {
    const report = this.createBaseReport("H002", "Unused indexes", nodeName);
    const version = await this.getPostgresVersion(cluster, nodeName);
    const indexes = await this.getUnusedIndexes(cluster, nodeName);

    // Group by database
    const byDatabase: Record<string, unknown> = {};
    for (const entry of indexes) {
      const db = entry.database as string;
      if (!byDatabase[db]) {
        byDatabase[db] = {
          unused_indexes: [],
          total_count: 0,
        };
      }
      (byDatabase[db] as Record<string, unknown[]>).unused_indexes.push(entry);
      (byDatabase[db] as Record<string, number>).total_count++;
    }

    report.results[nodeName] = {
      data: byDatabase,
      postgres_version: version as ReportNode["postgres_version"],
    };

    return report;
  }

  /**
   * Generate all reports for a cluster
   */
  async generateAllReports(
    cluster: string,
    nodeName: string = "node-01",
    combineNodes: boolean = true
  ): Promise<Record<string, Report>> {
    const reports: Record<string, Report> = {};

    console.log(`Generating reports for cluster: ${cluster}`);

    // Generate all reports
    const generators: Array<[string, () => Promise<Report>]> = [
      ["A002", () => this.generateA002Report(cluster, nodeName)],
      ["A003", () => this.generateA003Report(cluster, nodeName)],
      ["A007", () => this.generateA007Report(cluster, nodeName)],
      ["D004", () => this.generateD004Report(cluster, nodeName)],
      ["F001", () => this.generateF001Report(cluster, nodeName)],
      ["F004", () => this.generateF004Report(cluster, nodeName)],
      ["F005", () => this.generateF005Report(cluster, nodeName)],
      ["G001", () => this.generateG001Report(cluster, nodeName)],
      ["H001", () => this.generateH001Report(cluster, nodeName)],
      ["H002", () => this.generateH002Report(cluster, nodeName)],
    ];

    for (const [checkId, generator] of generators) {
      try {
        console.log(`  Generating ${checkId}...`);
        reports[checkId] = await generator();
      } catch (error) {
        console.error(`  Error generating ${checkId}:`, error);
      }
    }

    return reports;
  }
}

// CLI entrypoint
if (import.meta.main) {
  const prometheusUrl = process.env.PROMETHEUS_URL || "http://localhost:8428";
  const postgresSinkUrl =
    process.env.POSTGRES_SINK_URL || "postgresql://pgwatch@localhost:5432/measurements";

  const generator = new PostgresReportGenerator(prometheusUrl, postgresSinkUrl);

  // Check connection
  const connected = await generator.testConnection();
  if (!connected) {
    console.error("Cannot connect to Prometheus");
    process.exit(1);
  }

  // Get clusters
  const clusters = await generator.getAllClusters();
  console.log("Discovered clusters:", clusters);

  // Generate reports for each cluster
  for (const cluster of clusters.length > 0 ? clusters : ["local"]) {
    const reports = await generator.generateAllReports(cluster);

    // Write reports to files
    for (const [checkId, report] of Object.entries(reports)) {
      const filename = `${cluster}_${checkId}.json`;
      fs.writeFileSync(filename, JSON.stringify(report, null, 2));
      console.log(`Written: ${filename}`);
    }
  }
}
