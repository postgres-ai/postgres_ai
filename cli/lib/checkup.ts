/**
 * Express Checkup Module
 * ======================
 * Generates JSON health check reports directly from PostgreSQL without Prometheus.
 * 
 * ARCHITECTURAL DECISIONS
 * -----------------------
 * 
 * 1. SINGLE SOURCE OF TRUTH FOR SQL QUERIES
 *    Complex metrics (index health, settings, db_stats) are loaded from 
 *    config/pgwatch-prometheus/metrics.yml via getMetricSql() from metrics-loader.ts.
 *    
 *    Simple queries (version, database list, connection states, uptime) use
 *    inline SQL as they're trivial and CLI-specific.
 * 
 * 2. JSON SCHEMA COMPLIANCE
 *    All generated reports MUST comply with JSON schemas in reporter/schemas/.
 *    These schemas define the expected format for both:
 *    - Full-fledged monitoring reporter output
 *    - Express checkup output
 * 
 *    Before adding or modifying a report, verify the corresponding schema exists
 *    and ensure the output matches. Run schema validation tests to confirm.
 * 
 * ADDING NEW REPORTS
 * ------------------
 * 1. Add/verify the metric exists in config/pgwatch-prometheus/metrics.yml
 * 2. Add the metric name mapping to METRIC_NAMES in metrics-loader.ts
 * 3. Verify JSON schema exists in reporter/schemas/{CHECK_ID}.schema.json
 * 4. Implement the generator function using getMetricSql()
 * 5. Add schema validation test in test/schema-validation.test.ts
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import * as pkg from "../package.json";
import { getMetricSql, transformMetricRow, METRIC_NAMES } from "./metrics-loader";

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
 * Invalid index entry (H001) - matches H001.schema.json invalidIndex
 */
export interface InvalidIndex {
  schema_name: string;
  table_name: string;
  index_name: string;
  relation_name: string;
  index_size_bytes: number;
  index_size_pretty: string;
  supports_fk: boolean;
}

/**
 * Unused index entry (H002) - matches H002.schema.json unusedIndex
 */
export interface UnusedIndex {
  schema_name: string;
  table_name: string;
  index_name: string;
  index_definition: string;
  reason: string;
  idx_scan: number;
  index_size_bytes: number;
  idx_is_btree: boolean;
  supports_fk: boolean;
  index_size_pretty: string;
}

/**
 * Stats reset info for H002 - matches H002.schema.json statsReset
 */
export interface StatsReset {
  stats_reset_epoch: number | null;
  stats_reset_time: string | null;
  days_since_reset: number | null;
  postmaster_startup_epoch: number | null;
  postmaster_startup_time: string | null;
}

/**
 * Redundant index entry (H004) - matches H004.schema.json redundantIndex
 */
/**
 * Index that makes another index redundant.
 * Used in redundant_to array to show which indexes this one is redundant to.
 */
export interface RedundantToIndex {
  index_name: string;
  index_definition: string;
  index_size_bytes: number;
  index_size_pretty: string;
}

export interface RedundantIndex {
  schema_name: string;
  table_name: string;
  index_name: string;
  relation_name: string;
  access_method: string;
  reason: string;
  index_size_bytes: number;
  table_size_bytes: number;
  index_usage: number;
  supports_fk: boolean;
  index_definition: string;
  index_size_pretty: string;
  table_size_pretty: string;
  redundant_to: RedundantToIndex[];
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
  generation_mode: string | null;
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
 * Format bytes to human readable string using binary units (1024-based).
 * Uses IEC standard: KiB, MiB, GiB, etc.
 * 
 * Note: PostgreSQL's pg_size_pretty() uses kB/MB/GB with 1024 base (technically
 * incorrect SI usage), but we follow IEC binary units per project style guide.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Format a setting's pretty value from the normalized value and unit.
 * The settings metric provides setting_normalized (bytes or seconds) and unit_normalized.
 */
function formatSettingPrettyValue(
  settingNormalized: number | null,
  unitNormalized: string | null,
  rawValue: string
): string {
  if (settingNormalized === null || unitNormalized === null) {
    return rawValue;
  }
  
  if (unitNormalized === "bytes") {
    return formatBytes(settingNormalized);
  }
  
  if (unitNormalized === "seconds") {
    if (settingNormalized < 1) {
      return `${(settingNormalized * 1000).toFixed(0)} ms`;
    } else if (settingNormalized < 60) {
      return `${settingNormalized} s`;
    } else {
      return `${(settingNormalized / 60).toFixed(1)} min`;
    }
  }
  
  return rawValue;
}

/**
 * Get PostgreSQL version information
 * Uses simple inline SQL (trivial query, CLI-specific)
 */
export async function getPostgresVersion(client: Client): Promise<PostgresVersion> {
  const result = await client.query(`
    select name, setting
    from pg_settings
    where name in ('server_version', 'server_version_num')
  `);

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
 * Uses 'settings' metric from metrics.yml
 */
export async function getSettings(client: Client, pgMajorVersion: number = 16): Promise<Record<string, SettingInfo>> {
  const sql = getMetricSql(METRIC_NAMES.settings, pgMajorVersion);
  const result = await client.query(sql);
  const settings: Record<string, SettingInfo> = {};

  for (const row of result.rows) {
    // The settings metric uses tag_setting_name, tag_setting_value, etc.
    const name = row.tag_setting_name;
    const settingValue = row.tag_setting_value;
    const unit = row.tag_unit || "";
    const category = row.tag_category || "";
    const vartype = row.tag_vartype || "";
    const settingNormalized = row.setting_normalized !== null ? parseFloat(row.setting_normalized) : null;
    const unitNormalized = row.unit_normalized || null;
    
    settings[name] = {
      setting: settingValue,
      unit,
      category,
      context: "", // Not available in the monitoring metric
      vartype,
      pretty_value: formatSettingPrettyValue(settingNormalized, unitNormalized, settingValue),
    };
  }

  return settings;
}

/**
 * Get altered (non-default) PostgreSQL settings
 * Uses 'settings' metric from metrics.yml and filters for non-default
 */
export async function getAlteredSettings(client: Client, pgMajorVersion: number = 16): Promise<Record<string, AlteredSetting>> {
  const sql = getMetricSql(METRIC_NAMES.settings, pgMajorVersion);
  const result = await client.query(sql);
  const settings: Record<string, AlteredSetting> = {};

  for (const row of result.rows) {
    // Filter for non-default settings (is_default = 0 means non-default)
    if (row.is_default === 0 || row.is_default === false) {
      const name = row.tag_setting_name;
      const settingValue = row.tag_setting_value;
      const unit = row.tag_unit || "";
      const category = row.tag_category || "";
      const settingNormalized = row.setting_normalized !== null ? parseFloat(row.setting_normalized) : null;
      const unitNormalized = row.unit_normalized || null;
      
      settings[name] = {
        value: settingValue,
        unit,
        category,
        pretty_value: formatSettingPrettyValue(settingNormalized, unitNormalized, settingValue),
      };
    }
  }

  return settings;
}

/**
 * Get database sizes (all non-template databases)
 * Uses simple inline SQL (lists all databases, CLI-specific)
 */
export async function getDatabaseSizes(client: Client): Promise<Record<string, number>> {
  const result = await client.query(`
    select
      datname,
      pg_database_size(datname) as size_bytes
    from pg_database
    where datistemplate = false
    order by size_bytes desc
  `);
  const sizes: Record<string, number> = {};

  for (const row of result.rows) {
    sizes[row.datname] = parseInt(row.size_bytes, 10);
  }

  return sizes;
}

/**
 * Get cluster general info metrics
 * Uses 'db_stats' metric and inline SQL for connection states/uptime
 */
export async function getClusterInfo(client: Client, pgMajorVersion: number = 16): Promise<Record<string, ClusterMetric>> {
  const info: Record<string, ClusterMetric> = {};

  // Get database statistics from db_stats metric
  const dbStatsSql = getMetricSql(METRIC_NAMES.dbStats, pgMajorVersion);
  const statsResult = await client.query(dbStatsSql);
  if (statsResult.rows.length > 0) {
    const stats = statsResult.rows[0];

    info.total_connections = {
      value: String(stats.numbackends || 0),
      unit: "connections",
      description: "Current database connections",
    };

    info.total_commits = {
      value: String(stats.xact_commit || 0),
      unit: "transactions",
      description: "Total committed transactions",
    };

    info.total_rollbacks = {
      value: String(stats.xact_rollback || 0),
      unit: "transactions",
      description: "Total rolled back transactions",
    };

    const blocksHit = parseInt(stats.blks_hit || "0", 10);
    const blocksRead = parseInt(stats.blks_read || "0", 10);
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
      value: String(stats.tup_returned || 0),
      unit: "rows",
      description: "Total rows returned by queries",
    };

    info.tuples_fetched = {
      value: String(stats.tup_fetched || 0),
      unit: "rows",
      description: "Total rows fetched by queries",
    };

    info.tuples_inserted = {
      value: String(stats.tup_inserted || 0),
      unit: "rows",
      description: "Total rows inserted",
    };

    info.tuples_updated = {
      value: String(stats.tup_updated || 0),
      unit: "rows",
      description: "Total rows updated",
    };

    info.tuples_deleted = {
      value: String(stats.tup_deleted || 0),
      unit: "rows",
      description: "Total rows deleted",
    };

    info.total_deadlocks = {
      value: String(stats.deadlocks || 0),
      unit: "deadlocks",
      description: "Total deadlocks detected",
    };

    info.temp_files_created = {
      value: String(stats.temp_files || 0),
      unit: "files",
      description: "Total temporary files created",
    };

    const tempBytes = parseInt(stats.temp_bytes || "0", 10);
    info.temp_bytes_written = {
      value: formatBytes(tempBytes),
      unit: "bytes",
      description: "Total temporary file bytes written",
    };

    // Uptime from db_stats
    if (stats.postmaster_uptime_s) {
      const uptimeSeconds = parseInt(stats.postmaster_uptime_s, 10);
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      info.uptime = {
        value: `${days} days ${hours}:${String(minutes).padStart(2, "0")}:${String(uptimeSeconds % 60).padStart(2, "0")}`,
        unit: "interval",
        description: "Server uptime",
      };
    }
  }

  // Get connection states (simple inline SQL)
  const connResult = await client.query(`
    select
      coalesce(state, 'null') as state,
      count(*) as count
    from pg_stat_activity
    group by state
  `);
  for (const row of connResult.rows) {
    const stateKey = `connections_${row.state.replace(/\s+/g, "_")}`;
    info[stateKey] = {
      value: String(row.count),
      unit: "connections",
      description: `Connections in '${row.state}' state`,
    };
  }

  // Get uptime info (simple inline SQL)
  const uptimeResult = await client.query(`
    select
      pg_postmaster_start_time() as start_time,
      current_timestamp - pg_postmaster_start_time() as uptime
  `);
  if (uptimeResult.rows.length > 0) {
    const uptime = uptimeResult.rows[0];
    const startTime = uptime.start_time instanceof Date
      ? uptime.start_time.toISOString()
      : String(uptime.start_time);
    info.start_time = {
      value: startTime,
      unit: "timestamp",
      description: "PostgreSQL server start time",
    };
    if (!info.uptime) {
      info.uptime = {
        value: String(uptime.uptime),
        unit: "interval",
        description: "Server uptime",
      };
    }
  }

  return info;
}

/**
 * Get invalid indexes (H001)
 * SQL loaded from config/pgwatch-prometheus/metrics.yml (pg_invalid_indexes)
 */
export async function getInvalidIndexes(client: Client, pgMajorVersion: number = 16): Promise<InvalidIndex[]> {
  const sql = getMetricSql(METRIC_NAMES.H001, pgMajorVersion);
  const result = await client.query(sql);
  return result.rows.map((row) => {
    const transformed = transformMetricRow(row);
    const indexSizeBytes = parseInt(String(transformed.index_size_bytes || 0), 10);
    return {
      schema_name: String(transformed.schema_name || ""),
      table_name: String(transformed.table_name || ""),
      index_name: String(transformed.index_name || ""),
      relation_name: String(transformed.relation_name || ""),
      index_size_bytes: indexSizeBytes,
      index_size_pretty: formatBytes(indexSizeBytes),
      supports_fk: transformed.supports_fk === true || transformed.supports_fk === 1,
    };
  });
}

/**
 * Get unused indexes (H002)
 * SQL loaded from config/pgwatch-prometheus/metrics.yml (unused_indexes)
 */
export async function getUnusedIndexes(client: Client, pgMajorVersion: number = 16): Promise<UnusedIndex[]> {
  const sql = getMetricSql(METRIC_NAMES.H002, pgMajorVersion);
  const result = await client.query(sql);
  return result.rows.map((row) => {
    const transformed = transformMetricRow(row);
    const indexSizeBytes = parseInt(String(transformed.index_size_bytes || 0), 10);
    return {
      schema_name: String(transformed.schema_name || ""),
      table_name: String(transformed.table_name || ""),
      index_name: String(transformed.index_name || ""),
      index_definition: String(transformed.index_definition || ""),
      reason: String(transformed.reason || ""),
      idx_scan: parseInt(String(transformed.idx_scan || 0), 10),
      index_size_bytes: indexSizeBytes,
      idx_is_btree: transformed.idx_is_btree === true || transformed.idx_is_btree === "t",
      supports_fk: transformed.supports_fk === true || transformed.supports_fk === 1,
      index_size_pretty: formatBytes(indexSizeBytes),
    };
  });
}

/**
 * Get stats reset info (H002)
 * SQL loaded from config/pgwatch-prometheus/metrics.yml (stats_reset)
 */
export async function getStatsReset(client: Client, pgMajorVersion: number = 16): Promise<StatsReset> {
  const sql = getMetricSql(METRIC_NAMES.statsReset, pgMajorVersion);
  const result = await client.query(sql);
  const row = result.rows[0] || {};
  
  // The stats_reset metric returns stats_reset_epoch and seconds_since_reset
  // We need to calculate additional fields
  const statsResetEpoch = row.stats_reset_epoch ? parseFloat(row.stats_reset_epoch) : null;
  const secondsSinceReset = row.seconds_since_reset ? parseInt(row.seconds_since_reset, 10) : null;
  
  // Calculate stats_reset_time from epoch
  const statsResetTime = statsResetEpoch 
    ? new Date(statsResetEpoch * 1000).toISOString()
    : null;
  
  // Calculate days since reset
  const daysSinceReset = secondsSinceReset !== null
    ? Math.floor(secondsSinceReset / 86400)
    : null;
  
  // Get postmaster startup time separately (simple inline SQL)
  let postmasterStartupEpoch: number | null = null;
  let postmasterStartupTime: string | null = null;
  try {
    const pmResult = await client.query(`
      select
        extract(epoch from pg_postmaster_start_time()) as postmaster_startup_epoch,
        pg_postmaster_start_time()::text as postmaster_startup_time
    `);
    if (pmResult.rows.length > 0) {
      postmasterStartupEpoch = pmResult.rows[0].postmaster_startup_epoch 
        ? parseFloat(pmResult.rows[0].postmaster_startup_epoch) 
        : null;
      postmasterStartupTime = pmResult.rows[0].postmaster_startup_time || null;
    }
  } catch {
    // Ignore errors
  }
  
  return {
    stats_reset_epoch: statsResetEpoch,
    stats_reset_time: statsResetTime,
    days_since_reset: daysSinceReset,
    postmaster_startup_epoch: postmasterStartupEpoch,
    postmaster_startup_time: postmasterStartupTime,
  };
}

/**
 * Get current database name and size
 * Uses 'db_size' metric from metrics.yml
 */
export async function getCurrentDatabaseInfo(client: Client, pgMajorVersion: number = 16): Promise<{ datname: string; size_bytes: number }> {
  const sql = getMetricSql(METRIC_NAMES.dbSize, pgMajorVersion);
  const result = await client.query(sql);
  const row = result.rows[0] || {};
  
  // db_size metric returns tag_datname and size_b
  return {
    datname: row.tag_datname || "postgres",
    size_bytes: parseInt(row.size_b || "0", 10),
  };
}

/**
 * Get redundant indexes (H004)
 * SQL loaded from config/pgwatch-prometheus/metrics.yml (redundant_indexes)
 */
export async function getRedundantIndexes(client: Client, pgMajorVersion: number = 16): Promise<RedundantIndex[]> {
  const sql = getMetricSql(METRIC_NAMES.H004, pgMajorVersion);
  const result = await client.query(sql);
  return result.rows.map((row) => {
    const transformed = transformMetricRow(row);
    const indexSizeBytes = parseInt(String(transformed.index_size_bytes || 0), 10);
    const tableSizeBytes = parseInt(String(transformed.table_size_bytes || 0), 10);
    
    // Parse redundant_to JSON array (indexes that make this one redundant)
    let redundantTo: RedundantToIndex[] = [];
    try {
      const jsonStr = String(transformed.redundant_to_json || "[]");
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        redundantTo = parsed.map((item: any) => {
          const sizeBytes = parseInt(String(item.index_size_bytes || 0), 10);
          return {
            index_name: String(item.index_name || ""),
            index_definition: String(item.index_definition || ""),
            index_size_bytes: sizeBytes,
            index_size_pretty: formatBytes(sizeBytes),
          };
        });
      }
    } catch {
      // If JSON parsing fails, leave as empty array
    }
    
    return {
      schema_name: String(transformed.schema_name || ""),
      table_name: String(transformed.table_name || ""),
      index_name: String(transformed.index_name || ""),
      relation_name: String(transformed.relation_name || ""),
      access_method: String(transformed.access_method || ""),
      reason: String(transformed.reason || ""),
      index_size_bytes: indexSizeBytes,
      table_size_bytes: tableSizeBytes,
      index_usage: parseInt(String(transformed.index_usage || 0), 10),
      supports_fk: transformed.supports_fk === true || transformed.supports_fk === 1,
      index_definition: String(transformed.index_definition || ""),
      index_size_pretty: formatBytes(indexSizeBytes),
      table_size_pretty: formatBytes(tableSizeBytes),
      redundant_to: redundantTo,
    };
  });
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
    generation_mode: "express",
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
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const settings = await getSettings(client, pgMajorVersion);

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
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const generalInfo = await getClusterInfo(client, pgMajorVersion);
  const databaseSizes = await getDatabaseSizes(client);

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
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const alteredSettings = await getAlteredSettings(client, pgMajorVersion);

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
 * Generate H001 report - Invalid indexes
 */
export async function generateH001(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("H001", "Invalid indexes", nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const invalidIndexes = await getInvalidIndexes(client, pgMajorVersion);
  
  // Get current database name and size
  const { datname: dbName, size_bytes: dbSizeBytes } = await getCurrentDatabaseInfo(client, pgMajorVersion);

  // Calculate totals
  const totalCount = invalidIndexes.length;
  const totalSizeBytes = invalidIndexes.reduce((sum, idx) => sum + idx.index_size_bytes, 0);

  // Structure data by database name per schema
  report.results[nodeName] = {
    data: {
      [dbName]: {
        invalid_indexes: invalidIndexes,
        total_count: totalCount,
        total_size_bytes: totalSizeBytes,
        total_size_pretty: formatBytes(totalSizeBytes),
        database_size_bytes: dbSizeBytes,
        database_size_pretty: formatBytes(dbSizeBytes),
      },
    },
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate H002 report - Unused indexes
 */
export async function generateH002(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("H002", "Unused indexes", nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const unusedIndexes = await getUnusedIndexes(client, pgMajorVersion);
  const statsReset = await getStatsReset(client, pgMajorVersion);
  
  // Get current database name and size
  const { datname: dbName, size_bytes: dbSizeBytes } = await getCurrentDatabaseInfo(client, pgMajorVersion);

  // Calculate totals
  const totalCount = unusedIndexes.length;
  const totalSizeBytes = unusedIndexes.reduce((sum, idx) => sum + idx.index_size_bytes, 0);

  // Structure data by database name per schema
  report.results[nodeName] = {
    data: {
      [dbName]: {
        unused_indexes: unusedIndexes,
        total_count: totalCount,
        total_size_bytes: totalSizeBytes,
        total_size_pretty: formatBytes(totalSizeBytes),
        database_size_bytes: dbSizeBytes,
        database_size_pretty: formatBytes(dbSizeBytes),
        stats_reset: statsReset,
      },
    },
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate H004 report - Redundant indexes
 */
export async function generateH004(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("H004", "Redundant indexes", nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const redundantIndexes = await getRedundantIndexes(client, pgMajorVersion);
  
  // Get current database name and size
  const { datname: dbName, size_bytes: dbSizeBytes } = await getCurrentDatabaseInfo(client, pgMajorVersion);

  // Calculate totals
  const totalCount = redundantIndexes.length;
  const totalSizeBytes = redundantIndexes.reduce((sum, idx) => sum + idx.index_size_bytes, 0);

  // Structure data by database name per schema
  report.results[nodeName] = {
    data: {
      [dbName]: {
        redundant_indexes: redundantIndexes,
        total_count: totalCount,
        total_size_bytes: totalSizeBytes,
        total_size_pretty: formatBytes(totalSizeBytes),
        database_size_bytes: dbSizeBytes,
        database_size_pretty: formatBytes(dbSizeBytes),
      },
    },
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate D004 report - pg_stat_statements and pg_stat_kcache settings
 */
async function generateD004(client: Client, nodeName: string): Promise<Report> {
  const report = createBaseReport("D004", "pg_stat_statements and pg_stat_kcache settings", nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const allSettings = await getSettings(client, pgMajorVersion);

  // Filter settings related to pg_stat_statements and pg_stat_kcache
  const pgssSettings: Record<string, SettingInfo> = {};
  for (const [name, setting] of Object.entries(allSettings)) {
    if (name.startsWith("pg_stat_statements") || name.startsWith("pg_stat_kcache")) {
      pgssSettings[name] = setting;
    }
  }

  // Check pg_stat_statements extension
  let pgssAvailable = false;
  let pgssMetricsCount = 0;
  let pgssTotalCalls = 0;
  const pgssSampleQueries: Array<{ queryid: string; user: string; database: string; calls: number }> = [];

  try {
    const extCheck = await client.query(
      "select 1 from pg_extension where extname = 'pg_stat_statements'"
    );
    if (extCheck.rows.length > 0) {
      pgssAvailable = true;
      const statsResult = await client.query(`
        select count(*) as cnt, coalesce(sum(calls), 0) as total_calls
        from pg_stat_statements
      `);
      pgssMetricsCount = parseInt(statsResult.rows[0]?.cnt || "0", 10);
      pgssTotalCalls = parseInt(statsResult.rows[0]?.total_calls || "0", 10);

      // Get sample queries (top 5 by calls)
      const sampleResult = await client.query(`
        select
          queryid::text as queryid,
          coalesce(usename, 'unknown') as "user",
          coalesce(datname, 'unknown') as database,
          calls
        from pg_stat_statements s
        left join pg_database d on s.dbid = d.oid
        left join pg_user u on s.userid = u.usesysid
        order by calls desc
        limit 5
      `);
      for (const row of sampleResult.rows) {
        pgssSampleQueries.push({
          queryid: row.queryid,
          user: row.user,
          database: row.database,
          calls: parseInt(row.calls, 10),
        });
      }
    }
  } catch {
    // Extension not available or accessible
  }

  // Check pg_stat_kcache extension
  let kcacheAvailable = false;
  let kcacheMetricsCount = 0;
  let kcacheTotalExecTime = 0;
  let kcacheTotalUserTime = 0;
  let kcacheTotalSystemTime = 0;
  const kcacheSampleQueries: Array<{ queryid: string; user: string; exec_total_time: number }> = [];

  try {
    const extCheck = await client.query(
      "select 1 from pg_extension where extname = 'pg_stat_kcache'"
    );
    if (extCheck.rows.length > 0) {
      kcacheAvailable = true;
      const statsResult = await client.query(`
        select
          count(*) as cnt,
          coalesce(sum(exec_user_time + exec_system_time), 0) as total_exec_time,
          coalesce(sum(exec_user_time), 0) as total_user_time,
          coalesce(sum(exec_system_time), 0) as total_system_time
        from pg_stat_kcache
      `);
      kcacheMetricsCount = parseInt(statsResult.rows[0]?.cnt || "0", 10);
      kcacheTotalExecTime = parseFloat(statsResult.rows[0]?.total_exec_time || "0");
      kcacheTotalUserTime = parseFloat(statsResult.rows[0]?.total_user_time || "0");
      kcacheTotalSystemTime = parseFloat(statsResult.rows[0]?.total_system_time || "0");

      // Get sample queries (top 5 by exec time)
      const sampleResult = await client.query(`
        select
          queryid::text as queryid,
          coalesce(usename, 'unknown') as "user",
          (exec_user_time + exec_system_time) as exec_total_time
        from pg_stat_kcache k
        left join pg_user u on k.userid = u.usesysid
        order by (exec_user_time + exec_system_time) desc
        limit 5
      `);
      for (const row of sampleResult.rows) {
        kcacheSampleQueries.push({
          queryid: row.queryid,
          user: row.user,
          exec_total_time: parseFloat(row.exec_total_time),
        });
      }
    }
  } catch {
    // Extension not available or accessible
  }

  report.results[nodeName] = {
    data: {
      settings: pgssSettings,
      pg_stat_statements_status: {
        extension_available: pgssAvailable,
        metrics_count: pgssMetricsCount,
        total_calls: pgssTotalCalls,
        sample_queries: pgssSampleQueries,
      },
      pg_stat_kcache_status: {
        extension_available: kcacheAvailable,
        metrics_count: kcacheMetricsCount,
        total_exec_time: kcacheTotalExecTime,
        total_user_time: kcacheTotalUserTime,
        total_system_time: kcacheTotalSystemTime,
        sample_queries: kcacheSampleQueries,
      },
    },
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate F001 report - Autovacuum: current settings
 */
async function generateF001(client: Client, nodeName: string): Promise<Report> {
  const report = createBaseReport("F001", "Autovacuum: current settings", nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const allSettings = await getSettings(client, pgMajorVersion);

  // Filter autovacuum-related settings
  const autovacuumSettings: Record<string, SettingInfo> = {};
  for (const [name, setting] of Object.entries(allSettings)) {
    if (name.includes("autovacuum") || name.includes("vacuum")) {
      autovacuumSettings[name] = setting;
    }
  }

  report.results[nodeName] = {
    data: autovacuumSettings,
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate G001 report - Memory-related settings
 */
async function generateG001(client: Client, nodeName: string): Promise<Report> {
  const report = createBaseReport("G001", "Memory-related settings", nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const allSettings = await getSettings(client, pgMajorVersion);

  // Memory-related setting names
  const memorySettingNames = [
    "shared_buffers",
    "work_mem",
    "maintenance_work_mem",
    "effective_cache_size",
    "wal_buffers",
    "temp_buffers",
    "max_connections",
    "autovacuum_work_mem",
    "hash_mem_multiplier",
    "logical_decoding_work_mem",
    "max_stack_depth",
    "max_prepared_transactions",
    "max_locks_per_transaction",
    "max_pred_locks_per_transaction",
  ];

  const memorySettings: Record<string, SettingInfo> = {};
  for (const name of memorySettingNames) {
    if (allSettings[name]) {
      memorySettings[name] = allSettings[name];
    }
  }

  // Calculate memory usage estimates
  interface MemoryUsage {
    shared_buffers_bytes: number;
    shared_buffers_pretty: string;
    wal_buffers_bytes: number;
    wal_buffers_pretty: string;
    shared_memory_total_bytes: number;
    shared_memory_total_pretty: string;
    work_mem_per_connection_bytes: number;
    work_mem_per_connection_pretty: string;
    max_work_mem_usage_bytes: number;
    max_work_mem_usage_pretty: string;
    maintenance_work_mem_bytes: number;
    maintenance_work_mem_pretty: string;
    effective_cache_size_bytes: number;
    effective_cache_size_pretty: string;
  }

  let memoryUsage: MemoryUsage | Record<string, never> = {};

  try {
    // Get actual byte values from PostgreSQL
    const memQuery = await client.query(`
      select
        pg_size_bytes(current_setting('shared_buffers')) as shared_buffers_bytes,
        pg_size_bytes(current_setting('wal_buffers')) as wal_buffers_bytes,
        pg_size_bytes(current_setting('work_mem')) as work_mem_bytes,
        pg_size_bytes(current_setting('maintenance_work_mem')) as maintenance_work_mem_bytes,
        pg_size_bytes(current_setting('effective_cache_size')) as effective_cache_size_bytes,
        current_setting('max_connections')::int as max_connections
    `);

    if (memQuery.rows.length > 0) {
      const row = memQuery.rows[0];
      const sharedBuffersBytes = parseInt(row.shared_buffers_bytes, 10);
      const walBuffersBytes = parseInt(row.wal_buffers_bytes, 10);
      const workMemBytes = parseInt(row.work_mem_bytes, 10);
      const maintenanceWorkMemBytes = parseInt(row.maintenance_work_mem_bytes, 10);
      const effectiveCacheSizeBytes = parseInt(row.effective_cache_size_bytes, 10);
      const maxConnections = row.max_connections;

      const sharedMemoryTotal = sharedBuffersBytes + walBuffersBytes;
      const maxWorkMemUsage = workMemBytes * maxConnections;

      memoryUsage = {
        shared_buffers_bytes: sharedBuffersBytes,
        shared_buffers_pretty: formatBytes(sharedBuffersBytes),
        wal_buffers_bytes: walBuffersBytes,
        wal_buffers_pretty: formatBytes(walBuffersBytes),
        shared_memory_total_bytes: sharedMemoryTotal,
        shared_memory_total_pretty: formatBytes(sharedMemoryTotal),
        work_mem_per_connection_bytes: workMemBytes,
        work_mem_per_connection_pretty: formatBytes(workMemBytes),
        max_work_mem_usage_bytes: maxWorkMemUsage,
        max_work_mem_usage_pretty: formatBytes(maxWorkMemUsage),
        maintenance_work_mem_bytes: maintenanceWorkMemBytes,
        maintenance_work_mem_pretty: formatBytes(maintenanceWorkMemBytes),
        effective_cache_size_bytes: effectiveCacheSizeBytes,
        effective_cache_size_pretty: formatBytes(effectiveCacheSizeBytes),
      };
    }
  } catch {
    // If we can't calculate, leave empty object (schema allows this)
  }

  report.results[nodeName] = {
    data: {
      settings: memorySettings,
      analysis: {
        estimated_total_memory_usage: memoryUsage,
      },
    },
    postgres_version: postgresVersion,
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
  D004: generateD004,
  F001: generateF001,
  G001: generateG001,
  H001: generateH001,
  H002: generateH002,
  H004: generateH004,
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
  D004: "pg_stat_statements and pg_stat_kcache settings",
  F001: "Autovacuum: current settings",
  G001: "Memory-related settings",
  H001: "Invalid indexes",
  H002: "Unused indexes",
  H004: "Redundant indexes",
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
