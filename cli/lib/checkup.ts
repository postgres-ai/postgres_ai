/**
 * Express checkup module - generates JSON reports directly from PostgreSQL
 * without going through Prometheus.
 *
 * This module reuses the same SQL queries from metrics.yml but runs them
 * directly against the target database.
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import * as pkg from "../package.json";

/**
 * PostgreSQL version information
 */
export interface PostgresVersion {
  version: string;
  server_version_num: string;
  server_major_ver: string;
  server_minor_ver: string;
}

/**
 * Setting information from pg_settings
 */
export interface SettingInfo {
  setting: string;
  unit: string;
  category: string;
  context: string;
  vartype: string;
  pretty_value: string;
}

/**
 * Altered setting (A007) - subset of SettingInfo
 */
export interface AlteredSetting {
  value: string;
  unit: string;
  category: string;
  pretty_value: string;
}

/**
 * Cluster metric (A004)
 */
export interface ClusterMetric {
  value: string;
  unit: string;
  description: string;
}

/**
 * Node result for reports
 */
export interface NodeResult {
  data: Record<string, any>;
  postgres_version?: PostgresVersion;
}

/**
 * Report structure matching JSON schemas
 */
export interface Report {
  version: string | null;
  build_ts: string | null;
  checkId: string;
  checkTitle: string;
  timestamptz: string;
  nodes: {
    primary: string;
    standbys: string[];
  };
  results: Record<string, NodeResult>;
}

/**
 * SQL queries derived from metrics.yml
 * These are the same queries used by pgwatch to export metrics to Prometheus
 */
export const METRICS_SQL = {
  // From metrics.yml: settings metric
  // Queries pg_settings for all configuration parameters
  settings: `
    SELECT
      name,
      setting,
      COALESCE(unit, '') as unit,
      category,
      context,
      vartype,
      CASE
        WHEN unit = '8kB' THEN pg_size_pretty(setting::bigint * 8192)
        WHEN unit = 'kB' THEN pg_size_pretty(setting::bigint * 1024)
        WHEN unit = 'MB' THEN pg_size_pretty(setting::bigint * 1024 * 1024)
        WHEN unit = 'B' THEN pg_size_pretty(setting::bigint)
        WHEN unit = 'ms' THEN setting || ' ms'
        WHEN unit = 's' THEN setting || ' s'
        WHEN unit = 'min' THEN setting || ' min'
        ELSE setting
      END as pretty_value,
      source,
      CASE WHEN source <> 'default' THEN 0 ELSE 1 END as is_default
    FROM pg_settings
    ORDER BY name
  `,

  // Altered settings - non-default values only (A007)
  alteredSettings: `
    SELECT
      name,
      setting,
      COALESCE(unit, '') as unit,
      category,
      CASE
        WHEN unit = '8kB' THEN pg_size_pretty(setting::bigint * 8192)
        WHEN unit = 'kB' THEN pg_size_pretty(setting::bigint * 1024)
        WHEN unit = 'MB' THEN pg_size_pretty(setting::bigint * 1024 * 1024)
        WHEN unit = 'B' THEN pg_size_pretty(setting::bigint)
        WHEN unit = 'ms' THEN setting || ' ms'
        WHEN unit = 's' THEN setting || ' s'
        WHEN unit = 'min' THEN setting || ' min'
        ELSE setting
      END as pretty_value
    FROM pg_settings
    WHERE source <> 'default'
    ORDER BY name
  `,

  // Version info - extracts server_version and server_version_num
  version: `
    SELECT
      name,
      setting
    FROM pg_settings
    WHERE name IN ('server_version', 'server_version_num')
  `,

  // Database sizes (A004)
  databaseSizes: `
    SELECT
      datname,
      pg_database_size(datname) as size_bytes
    FROM pg_database
    WHERE datistemplate = false
    ORDER BY size_bytes DESC
  `,

  // Cluster statistics (A004)
  clusterStats: `
    SELECT
      sum(numbackends) as total_connections,
      sum(xact_commit) as total_commits,
      sum(xact_rollback) as total_rollbacks,
      sum(blks_read) as blocks_read,
      sum(blks_hit) as blocks_hit,
      sum(tup_returned) as tuples_returned,
      sum(tup_fetched) as tuples_fetched,
      sum(tup_inserted) as tuples_inserted,
      sum(tup_updated) as tuples_updated,
      sum(tup_deleted) as tuples_deleted,
      sum(deadlocks) as total_deadlocks,
      sum(temp_files) as temp_files_created,
      sum(temp_bytes) as temp_bytes_written
    FROM pg_stat_database
    WHERE datname IS NOT NULL
  `,

  // Connection states (A004)
  connectionStates: `
    SELECT
      COALESCE(state, 'null') as state,
      count(*) as count
    FROM pg_stat_activity
    GROUP BY state
  `,

  // Uptime info (A004)
  uptimeInfo: `
    SELECT
      pg_postmaster_start_time() as start_time,
      current_timestamp - pg_postmaster_start_time() as uptime
  `,
};

/**
 * Parse PostgreSQL version number into major and minor components
 */
export function parseVersionNum(versionNum: string): { major: string; minor: string } {
  if (!versionNum || versionNum.length < 6) {
    return { major: "", minor: "" };
  }
  try {
    const num = parseInt(versionNum, 10);
    return {
      major: Math.floor(num / 10000).toString(),
      minor: (num % 10000).toString(),
    };
  } catch {
    return { major: "", minor: "" };
  }
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Get PostgreSQL version information
 */
export async function getPostgresVersion(client: Client): Promise<PostgresVersion> {
  const result = await client.query(METRICS_SQL.version);

  let version = "";
  let serverVersionNum = "";

  for (const row of result.rows) {
    if (row.name === "server_version") {
      version = row.setting;
    } else if (row.name === "server_version_num") {
      serverVersionNum = row.setting;
    }
  }

  const { major, minor } = parseVersionNum(serverVersionNum);

  return {
    version,
    server_version_num: serverVersionNum,
    server_major_ver: major,
    server_minor_ver: minor,
  };
}

/**
 * Get all PostgreSQL settings
 */
export async function getSettings(client: Client): Promise<Record<string, SettingInfo>> {
  const result = await client.query(METRICS_SQL.settings);
  const settings: Record<string, SettingInfo> = {};

  for (const row of result.rows) {
    settings[row.name] = {
      setting: row.setting,
      unit: row.unit,
      category: row.category,
      context: row.context,
      vartype: row.vartype,
      pretty_value: row.pretty_value,
    };
  }

  return settings;
}

/**
 * Get altered (non-default) PostgreSQL settings
 */
export async function getAlteredSettings(client: Client): Promise<Record<string, AlteredSetting>> {
  const result = await client.query(METRICS_SQL.alteredSettings);
  const settings: Record<string, AlteredSetting> = {};

  for (const row of result.rows) {
    settings[row.name] = {
      value: row.setting,
      unit: row.unit,
      category: row.category,
      pretty_value: row.pretty_value,
    };
  }

  return settings;
}

/**
 * Get database sizes
 */
export async function getDatabaseSizes(client: Client): Promise<Record<string, number>> {
  const result = await client.query(METRICS_SQL.databaseSizes);
  const sizes: Record<string, number> = {};

  for (const row of result.rows) {
    sizes[row.datname] = parseInt(row.size_bytes, 10);
  }

  return sizes;
}

/**
 * Get cluster general info metrics
 */
export async function getClusterInfo(client: Client): Promise<Record<string, ClusterMetric>> {
  const info: Record<string, ClusterMetric> = {};

  // Get cluster statistics
  const statsResult = await client.query(METRICS_SQL.clusterStats);
  if (statsResult.rows.length > 0) {
    const stats = statsResult.rows[0];

    info.total_connections = {
      value: String(stats.total_connections || 0),
      unit: "connections",
      description: "Total active database connections",
    };

    info.total_commits = {
      value: String(stats.total_commits || 0),
      unit: "transactions",
      description: "Total committed transactions",
    };

    info.total_rollbacks = {
      value: String(stats.total_rollbacks || 0),
      unit: "transactions",
      description: "Total rolled back transactions",
    };

    const blocksHit = parseInt(stats.blocks_hit || "0", 10);
    const blocksRead = parseInt(stats.blocks_read || "0", 10);
    const totalBlocks = blocksHit + blocksRead;
    const cacheHitRatio = totalBlocks > 0 ? ((blocksHit / totalBlocks) * 100).toFixed(2) : "0.00";

    info.cache_hit_ratio = {
      value: cacheHitRatio,
      unit: "%",
      description: "Buffer cache hit ratio",
    };

    info.blocks_read = {
      value: String(blocksRead),
      unit: "blocks",
      description: "Total disk blocks read",
    };

    info.blocks_hit = {
      value: String(blocksHit),
      unit: "blocks",
      description: "Total buffer cache hits",
    };

    info.tuples_returned = {
      value: String(stats.tuples_returned || 0),
      unit: "rows",
      description: "Total rows returned by queries",
    };

    info.tuples_fetched = {
      value: String(stats.tuples_fetched || 0),
      unit: "rows",
      description: "Total rows fetched by queries",
    };

    info.tuples_inserted = {
      value: String(stats.tuples_inserted || 0),
      unit: "rows",
      description: "Total rows inserted",
    };

    info.tuples_updated = {
      value: String(stats.tuples_updated || 0),
      unit: "rows",
      description: "Total rows updated",
    };

    info.tuples_deleted = {
      value: String(stats.tuples_deleted || 0),
      unit: "rows",
      description: "Total rows deleted",
    };

    info.total_deadlocks = {
      value: String(stats.total_deadlocks || 0),
      unit: "deadlocks",
      description: "Total deadlocks detected",
    };

    info.temp_files_created = {
      value: String(stats.temp_files_created || 0),
      unit: "files",
      description: "Total temporary files created",
    };

    const tempBytes = parseInt(stats.temp_bytes_written || "0", 10);
    info.temp_bytes_written = {
      value: formatBytes(tempBytes),
      unit: "bytes",
      description: "Total temporary file bytes written",
    };
  }

  // Get connection states
  const connResult = await client.query(METRICS_SQL.connectionStates);
  for (const row of connResult.rows) {
    const stateKey = `connections_${row.state.replace(/\s+/g, "_")}`;
    info[stateKey] = {
      value: String(row.count),
      unit: "connections",
      description: `Connections in '${row.state}' state`,
    };
  }

  // Get uptime info
  const uptimeResult = await client.query(METRICS_SQL.uptimeInfo);
  if (uptimeResult.rows.length > 0) {
    const uptime = uptimeResult.rows[0];
    info.start_time = {
      value: uptime.start_time.toISOString(),
      unit: "timestamp",
      description: "PostgreSQL server start time",
    };
    info.uptime = {
      value: uptime.uptime,
      unit: "interval",
      description: "Server uptime",
    };
  }

  return info;
}

/**
 * Create base report structure
 */
export function createBaseReport(
  checkId: string,
  checkTitle: string,
  nodeName: string
): Report {
  const buildTs = resolveBuildTs();
  return {
    version: pkg.version || null,
    build_ts: buildTs,
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

function readTextFileSafe(p: string): string | null {
  try {
    const value = fs.readFileSync(p, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function resolveBuildTs(): string | null {
  // Follow reporter.py approach: read BUILD_TS from filesystem, with env override.
  // Default: /BUILD_TS (useful in container images).
  const envPath = process.env.PGAI_BUILD_TS_FILE;
  const p = (envPath && envPath.trim()) ? envPath.trim() : "/BUILD_TS";

  const fromFile = readTextFileSafe(p);
  if (fromFile) return fromFile;

  // Fallback for packaged CLI: allow placing BUILD_TS next to dist/ (package root).
  // dist/lib/checkup.js => package root: dist/..
  try {
    const pkgRoot = path.resolve(__dirname, "..");
    const fromPkgFile = readTextFileSafe(path.join(pkgRoot, "BUILD_TS"));
    if (fromPkgFile) return fromPkgFile;
  } catch {
    // ignore
  }

  // Last resort: use package.json mtime as an approximation (non-null, stable-ish).
  try {
    const pkgJsonPath = path.resolve(__dirname, "..", "package.json");
    const st = fs.statSync(pkgJsonPath);
    return st.mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Generate A002 report - Postgres major version
 */
export async function generateA002(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("A002", "Postgres major version", nodeName);
  const postgresVersion = await getPostgresVersion(client);

  report.results[nodeName] = {
    data: {
      version: postgresVersion,
    },
  };

  return report;
}

/**
 * Generate A003 report - Postgres settings
 */
export async function generateA003(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("A003", "Postgres settings", nodeName);
  const settings = await getSettings(client);
  const postgresVersion = await getPostgresVersion(client);

  report.results[nodeName] = {
    data: settings,
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate A004 report - Cluster information
 */
export async function generateA004(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("A004", "Cluster information", nodeName);
  const generalInfo = await getClusterInfo(client);
  const databaseSizes = await getDatabaseSizes(client);
  const postgresVersion = await getPostgresVersion(client);

  report.results[nodeName] = {
    data: {
      general_info: generalInfo,
      database_sizes: databaseSizes,
    },
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate A007 report - Altered settings
 */
export async function generateA007(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("A007", "Altered settings", nodeName);
  const alteredSettings = await getAlteredSettings(client);
  const postgresVersion = await getPostgresVersion(client);

  report.results[nodeName] = {
    data: alteredSettings,
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate A013 report - Postgres minor version
 */
export async function generateA013(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("A013", "Postgres minor version", nodeName);
  const postgresVersion = await getPostgresVersion(client);

  report.results[nodeName] = {
    data: {
      version: postgresVersion,
    },
  };

  return report;
}

/**
 * Available report generators
 */
export const REPORT_GENERATORS: Record<string, (client: Client, nodeName: string) => Promise<Report>> = {
  A002: generateA002,
  A003: generateA003,
  A004: generateA004,
  A007: generateA007,
  A013: generateA013,
};

/**
 * Check IDs and titles
 */
export const CHECK_INFO: Record<string, string> = {
  A002: "Postgres major version",
  A003: "Postgres settings",
  A004: "Cluster information",
  A007: "Altered settings",
  A013: "Postgres minor version",
};

/**
 * Generate all available reports
 */
export async function generateAllReports(
  client: Client,
  nodeName: string = "node-01",
  onProgress?: (info: { checkId: string; checkTitle: string; index: number; total: number }) => void
): Promise<Record<string, Report>> {
  const reports: Record<string, Report> = {};

  const entries = Object.entries(REPORT_GENERATORS);
  const total = entries.length;
  let index = 0;

  for (const [checkId, generator] of entries) {
    index += 1;
    onProgress?.({
      checkId,
      checkTitle: CHECK_INFO[checkId] || checkId,
      index,
      total,
    });
    reports[checkId] = await generator(client, nodeName);
  }

  return reports;
}
