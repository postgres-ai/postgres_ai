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
 * 3. ERROR HANDLING STRATEGY
 *    Functions follow two patterns based on criticality:
 * 
 *    PROPAGATING (throws on error):
 *    - Core data functions: getPostgresVersion, getSettings, getAlteredSettings,
 *      getDatabaseSizes, getInvalidIndexes, getUnusedIndexes, getRedundantIndexes
 *    - If these fail, the entire report should fail (data is required)
 *    - Callers should handle errors at the report generation level
 * 
 *    GRACEFUL DEGRADATION (catches errors, includes error in output):
 *    - Optional/supplementary queries: pg_stat_statements, pg_stat_kcache checks,
 *      memory calculations, postmaster startup time
 *    - These are nice-to-have; missing data shouldn't fail the whole report
 *    - Errors are logged and included in report output for visibility
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
import { getCheckupTitle, buildCheckInfoMap } from "./checkup-dictionary";

// Time constants
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

/**
 * Convert various boolean representations to boolean.
 * PostgreSQL returns booleans as true/false, 1/0, 't'/'f', or 'true'/'false'
 * depending on context (query result, JDBC driver, etc.).
 */
function toBool(val: unknown): boolean {
  return val === true || val === 1 || val === "t" || val === "true";
}

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
 *
 * Decision tree for remediation recommendations:
 * 1. has_valid_duplicate=true → DROP (valid duplicate exists, safe to remove)
 * 2. is_pk=true or is_unique=true → RECREATE (backs a constraint, must restore)
 * 3. table_row_estimate < 10000 → RECREATE (small table, quick rebuild)
 * 4. Otherwise → UNCERTAIN (needs manual analysis of query plans)
 */
export interface InvalidIndex {
  schema_name: string;
  table_name: string;
  index_name: string;
  relation_name: string;
  index_size_bytes: number;
  index_size_pretty: string;
  /** Full CREATE INDEX statement from pg_get_indexdef() - useful for DROP/RECREATE migrations */
  index_definition: string;
  supports_fk: boolean;
  /** True if this index backs a PRIMARY KEY constraint */
  is_pk: boolean;
  /** True if this is a UNIQUE index (includes PK indexes) */
  is_unique: boolean;
  /** Name of the constraint this index backs, or null if none */
  constraint_name: string | null;
  /** Estimated row count of the table from pg_class.reltuples */
  table_row_estimate: number;
  /** True if there is a valid index on the same column(s) */
  has_valid_duplicate: boolean;
  /** Name of the valid duplicate index if one exists */
  valid_duplicate_name: string | null;
  /** Full CREATE INDEX statement of the valid duplicate index */
  valid_duplicate_definition: string | null;
}

/** Recommendation for handling an invalid index */
export type InvalidIndexRecommendation = "DROP" | "RECREATE" | "UNCERTAIN";

/** Threshold for considering a table "small" (quick to rebuild) */
const SMALL_TABLE_ROW_THRESHOLD = 10000;

/**
 * Compute remediation recommendation for an invalid index using decision tree.
 *
 * Decision tree logic:
 * 1. If has_valid_duplicate is true → DROP (valid duplicate exists, safe to remove)
 * 2. If is_pk or is_unique is true → RECREATE (backs a constraint, must restore)
 * 3. If table_row_estimate < 10000 → RECREATE (small table, quick rebuild)
 * 4. Otherwise → UNCERTAIN (needs manual analysis of query plans)
 *
 * @param index - Invalid index with observation data
 * @returns Recommendation: "DROP", "RECREATE", or "UNCERTAIN"
 */
export function getInvalidIndexRecommendation(index: InvalidIndex): InvalidIndexRecommendation {
  // 1. Valid duplicate exists - safe to drop
  if (index.has_valid_duplicate) {
    return "DROP";
  }

  // 2. Backs a constraint - must recreate
  if (index.is_pk || index.is_unique) {
    return "RECREATE";
  }

  // 3. Small table - quick to recreate
  if (index.table_row_estimate < SMALL_TABLE_ROW_THRESHOLD) {
    return "RECREATE";
  }

  // 4. Large table without clear path - needs manual analysis
  return "UNCERTAIN";
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
  /** Set when postmaster startup time query fails - indicates data availability issue */
  postmaster_startup_error?: string;
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
  /** Set when redundant_to_json parsing fails - indicates data quality issue */
  redundant_to_parse_error?: string;
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
  } catch (err) {
    // parseInt shouldn't throw, but handle edge cases defensively
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[parseVersionNum] Warning: Failed to parse "${versionNum}": ${errorMsg}`);
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
  if (bytes < 0) return `-${formatBytes(-bytes)}`; // Handle negative values
  if (!Number.isFinite(bytes)) return `${bytes} B`; // Handle NaN/Infinity
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
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
    // Format time values with appropriate units based on magnitude:
    // - Sub-second values (< 1s): show in milliseconds for precision
    // - Small values (< 60s): show in seconds
    // - Larger values (>= 60s): show in minutes for readability
    const MS_PER_SECOND = 1000;
    if (settingNormalized < 1) {
      return `${(settingNormalized * MS_PER_SECOND).toFixed(0)} ms`;
    } else if (settingNormalized < SECONDS_PER_MINUTE) {
      return `${settingNormalized} s`;
    } else {
      return `${(settingNormalized / SECONDS_PER_MINUTE).toFixed(1)} min`;
    }
  }
  
  return rawValue;
}

/**
 * Get PostgreSQL version information.
 * Uses simple inline SQL (trivial query, CLI-specific).
 * 
 * @throws {Error} If database query fails (propagating - critical data)
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
    if (!toBool(row.is_default)) {
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
      const days = Math.floor(uptimeSeconds / SECONDS_PER_DAY);
      const hours = Math.floor((uptimeSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
      const minutes = Math.floor((uptimeSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
      info.uptime = {
        value: `${days} days ${hours}:${String(minutes).padStart(2, "0")}:${String(uptimeSeconds % SECONDS_PER_MINUTE).padStart(2, "0")}`,
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
 * Get invalid indexes from the database (H001).
 * Invalid indexes have indisvalid = false, typically from failed CREATE INDEX CONCURRENTLY.
 *
 * @param client - Connected PostgreSQL client
 * @param pgMajorVersion - PostgreSQL major version (default: 16)
 * @returns Array of invalid index entries with observation data for decision tree analysis
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
      index_definition: String(transformed.index_definition || ""),
      supports_fk: toBool(transformed.supports_fk),
      is_pk: toBool(transformed.is_pk),
      is_unique: toBool(transformed.is_unique),
      constraint_name: transformed.constraint_name ? String(transformed.constraint_name) : null,
      table_row_estimate: parseInt(String(transformed.table_row_estimate || 0), 10),
      has_valid_duplicate: toBool(transformed.has_valid_duplicate),
      valid_duplicate_name: transformed.valid_index_name ? String(transformed.valid_index_name) : null,
      valid_duplicate_definition: transformed.valid_index_definition ? String(transformed.valid_index_definition) : null,
    };
  });
}

/**
 * Get unused indexes from the database (H002).
 * Unused indexes have zero scans since stats were last reset.
 *
 * @param client - Connected PostgreSQL client
 * @param pgMajorVersion - PostgreSQL major version (default: 16)
 * @returns Array of unused index entries with scan counts and FK support info
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
      idx_is_btree: toBool(transformed.idx_is_btree),
      supports_fk: toBool(transformed.supports_fk),
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
    ? Math.floor(secondsSinceReset / SECONDS_PER_DAY)
    : null;
  
  // Get postmaster startup time separately (simple inline SQL)
  // This is supplementary data - errors are captured in output, not propagated
  let postmasterStartupEpoch: number | null = null;
  let postmasterStartupTime: string | null = null;
  let postmasterStartupError: string | undefined;
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
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    postmasterStartupError = `Failed to query postmaster start time: ${errorMsg}`;
    console.log(`[getStatsReset] Warning: ${postmasterStartupError}`);
  }
  
  const statsResult: StatsReset = {
    stats_reset_epoch: statsResetEpoch,
    stats_reset_time: statsResetTime,
    days_since_reset: daysSinceReset,
    postmaster_startup_epoch: postmasterStartupEpoch,
    postmaster_startup_time: postmasterStartupTime,
  };
  
  // Only include error field if there was an error (keeps output clean)
  if (postmasterStartupError) {
    statsResult.postmaster_startup_error = postmasterStartupError;
  }
  
  return statsResult;
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
 * Type guard to validate redundant_to_json item structure.
 * Returns true if item is a valid object (may have expected properties).
 */
function isValidRedundantToItem(item: unknown): item is Record<string, unknown> {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}

/**
 * Get redundant indexes from the database (H004).
 * Redundant indexes are covered by other indexes (same leading columns).
 *
 * @param client - Connected PostgreSQL client
 * @param pgMajorVersion - PostgreSQL major version (default: 16)
 * @returns Array of redundant index entries with covering index info
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
    let parseError: string | undefined;
    try {
      const jsonStr = String(transformed.redundant_to_json || "[]");
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        redundantTo = parsed
          .filter(isValidRedundantToItem)
          .map((item) => {
            const sizeBytes = parseInt(String(item.index_size_bytes ?? 0), 10);
            return {
              index_name: String(item.index_name ?? ""),
              index_definition: String(item.index_definition ?? ""),
              index_size_bytes: sizeBytes,
              index_size_pretty: formatBytes(sizeBytes),
            };
          });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const indexName = String(transformed.index_name || "unknown");
      parseError = `Failed to parse redundant_to_json: ${errorMsg}`;
      console.log(`[H004] Warning: ${parseError} for index "${indexName}"`);
    }
    
    const result: RedundantIndex = {
      schema_name: String(transformed.schema_name || ""),
      table_name: String(transformed.table_name || ""),
      index_name: String(transformed.index_name || ""),
      relation_name: String(transformed.relation_name || ""),
      access_method: String(transformed.access_method || ""),
      reason: String(transformed.reason || ""),
      index_size_bytes: indexSizeBytes,
      table_size_bytes: tableSizeBytes,
      index_usage: parseInt(String(transformed.index_usage || 0), 10),
      supports_fk: toBool(transformed.supports_fk),
      index_definition: String(transformed.index_definition || ""),
      index_size_pretty: formatBytes(indexSizeBytes),
      table_size_pretty: formatBytes(tableSizeBytes),
      redundant_to: redundantTo,
    };
    
    // Only include parse error field if there was an error (keeps output clean)
    if (parseError) {
      result.redundant_to_parse_error = parseError;
    }
    
    return result;
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
    // Intentionally silent: this is a "safe" read that returns null on any error
    // (file not found, permission denied, etc.) - used for optional config files
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
  } catch (err) {
    // Path resolution failing is unexpected - warn about it
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[resolveBuildTs] Warning: path resolution failed: ${errorMsg}`);
  }

  // Last resort: use package.json mtime as an approximation (non-null, stable-ish).
  try {
    const pkgJsonPath = path.resolve(__dirname, "..", "package.json");
    const st = fs.statSync(pkgJsonPath);
    return st.mtime.toISOString();
  } catch (err) {
    // package.json not found is expected in some environments (e.g., bundled) - debug only
    if (process.env.DEBUG) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(`[resolveBuildTs] Could not stat package.json, using current time: ${errorMsg}`);
    }
    return new Date().toISOString();
  }
}

// ============================================================================
// Unified Report Generator Helpers
// ============================================================================

/**
 * Generate a simple version report (A002, A013).
 * These reports only contain PostgreSQL version information.
 */
async function generateVersionReport(
  client: Client,
  nodeName: string,
  checkId: string,
  checkTitle: string
): Promise<Report> {
  const report = createBaseReport(checkId, checkTitle, nodeName);
  const postgresVersion = await getPostgresVersion(client);
  report.results[nodeName] = { data: { version: postgresVersion } };
  return report;
}

/**
 * Generate a settings-based report (A003, A007).
 * Fetches settings using provided function and includes postgres_version.
 */
async function generateSettingsReport(
  client: Client,
  nodeName: string,
  checkId: string,
  checkTitle: string,
  fetchSettings: (client: Client, pgMajorVersion: number) => Promise<Record<string, unknown>>
): Promise<Report> {
  const report = createBaseReport(checkId, checkTitle, nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const settings = await fetchSettings(client, pgMajorVersion);
  report.results[nodeName] = { data: settings, postgres_version: postgresVersion };
  return report;
}

/**
 * Generate an index report (H001, H002, H004).
 * Common structure: index list + totals + database info, keyed by database name.
 */
async function generateIndexReport<T extends { index_size_bytes: number }>(
  client: Client,
  nodeName: string,
  checkId: string,
  checkTitle: string,
  indexFieldName: string,
  fetchIndexes: (client: Client, pgMajorVersion: number) => Promise<T[]>,
  extraFields?: (client: Client, pgMajorVersion: number) => Promise<Record<string, unknown>>
): Promise<Report> {
  const report = createBaseReport(checkId, checkTitle, nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const indexes = await fetchIndexes(client, pgMajorVersion);
  const { datname: dbName, size_bytes: dbSizeBytes } = await getCurrentDatabaseInfo(client, pgMajorVersion);

  const totalCount = indexes.length;
  const totalSizeBytes = indexes.reduce((sum, idx) => sum + idx.index_size_bytes, 0);

  const dbEntry: Record<string, unknown> = {
    [indexFieldName]: indexes,
    total_count: totalCount,
    total_size_bytes: totalSizeBytes,
    total_size_pretty: formatBytes(totalSizeBytes),
    database_size_bytes: dbSizeBytes,
    database_size_pretty: formatBytes(dbSizeBytes),
  };

  // Add extra fields if provided (e.g., stats_reset for H002)
  if (extraFields) {
    Object.assign(dbEntry, await extraFields(client, pgMajorVersion));
  }

  report.results[nodeName] = { data: { [dbName]: dbEntry }, postgres_version: postgresVersion };
  return report;
}

// ============================================================================
// Report Generators (using unified helpers)
// ============================================================================

/** Generate A002 report - Postgres major version */
export const generateA002 = (client: Client, nodeName = "node-01") =>
  generateVersionReport(client, nodeName, "A002", "Postgres major version");

/** Generate A003 report - Postgres settings */
export const generateA003 = (client: Client, nodeName = "node-01") =>
  generateSettingsReport(client, nodeName, "A003", "Postgres settings", getSettings);

/** Generate A004 report - Cluster information (custom structure) */
export async function generateA004(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("A004", "Cluster information", nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  report.results[nodeName] = {
    data: {
      general_info: await getClusterInfo(client, pgMajorVersion),
      database_sizes: await getDatabaseSizes(client),
    },
    postgres_version: postgresVersion,
  };
  return report;
}

/** Generate A007 report - Altered settings */
export const generateA007 = (client: Client, nodeName = "node-01") =>
  generateSettingsReport(client, nodeName, "A007", "Altered settings", getAlteredSettings);

/** Generate A013 report - Postgres minor version */
export const generateA013 = (client: Client, nodeName = "node-01") =>
  generateVersionReport(client, nodeName, "A013", "Postgres minor version");

/** Generate H001 report - Invalid indexes */
export const generateH001 = (client: Client, nodeName = "node-01") =>
  generateIndexReport(client, nodeName, "H001", "Invalid indexes", "invalid_indexes", getInvalidIndexes);

/** Generate H002 report - Unused indexes (includes stats_reset) */
export const generateH002 = (client: Client, nodeName = "node-01") =>
  generateIndexReport(client, nodeName, "H002", "Unused indexes", "unused_indexes", getUnusedIndexes,
    async (c, v) => ({ stats_reset: await getStatsReset(c, v) }));

/** Generate H004 report - Redundant indexes */
export const generateH004 = (client: Client, nodeName = "node-01") =>
  generateIndexReport(client, nodeName, "H004", "Redundant indexes", "redundant_indexes", getRedundantIndexes);

/**
 * Generate D004 report - pg_stat_statements and pg_stat_kcache settings.
 * 
 * Uses graceful degradation: extension queries are wrapped in try-catch
 * because extensions may not be installed. Errors are included in the
 * report output rather than failing the entire report.
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
  let pgssError: string | null = null;
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
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[D004] Error querying pg_stat_statements: ${errorMsg}`);
    pgssError = errorMsg;
  }

  // Check pg_stat_kcache extension
  let kcacheAvailable = false;
  let kcacheMetricsCount = 0;
  let kcacheTotalExecTime = 0;
  let kcacheTotalUserTime = 0;
  let kcacheTotalSystemTime = 0;
  let kcacheError: string | null = null;
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
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[D004] Error querying pg_stat_kcache: ${errorMsg}`);
    kcacheError = errorMsg;
  }

  report.results[nodeName] = {
    data: {
      settings: pgssSettings,
      pg_stat_statements_status: {
        extension_available: pgssAvailable,
        metrics_count: pgssMetricsCount,
        total_calls: pgssTotalCalls,
        sample_queries: pgssSampleQueries,
        ...(pgssError && { error: pgssError }),
      },
      pg_stat_kcache_status: {
        extension_available: kcacheAvailable,
        metrics_count: kcacheMetricsCount,
        total_exec_time: kcacheTotalExecTime,
        total_user_time: kcacheTotalUserTime,
        total_system_time: kcacheTotalSystemTime,
        sample_queries: kcacheSampleQueries,
        ...(kcacheError && { error: kcacheError }),
      },
    },
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate D001 report - Logging settings
 *
 * Collects all PostgreSQL logging-related settings including:
 * - Log destination and collector settings
 * - Log file rotation and naming
 * - Log verbosity and filtering
 * - Statement and duration logging
 */
async function generateD001(client: Client, nodeName: string): Promise<Report> {
  const report = createBaseReport("D001", "Logging settings", nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const allSettings = await getSettings(client, pgMajorVersion);

  // Filter logging-related settings (log_* and logging_*)
  const loggingSettings: Record<string, SettingInfo> = {};
  for (const [name, setting] of Object.entries(allSettings)) {
    if (name.startsWith("log_") || name.startsWith("logging_")) {
      loggingSettings[name] = setting;
    }
  }

  report.results[nodeName] = {
    data: loggingSettings,
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
 * Generate F004 report - Autovacuum: heap bloat estimate
 *
 * Estimates table bloat based on statistical analysis of table pages vs expected pages.
 * Uses pg_stats for column statistics to estimate row sizes.
 */
async function generateF004(client: Client, nodeName: string): Promise<Report> {
  const report = createBaseReport("F004", "Autovacuum: heap bloat estimate", nodeName);
  const postgresVersion = await getPostgresVersion(client);

  interface TableBloatRow {
    schemaname: string;
    tblname: string;
    real_size_bytes: string;
    real_size_pretty: string;
    extra_size_bytes: string;
    extra_size_pretty: string;
    extra_pct: string;
    fillfactor: string;
    bloat_size_bytes: string;
    bloat_size_pretty: string;
    bloat_pct: string;
    is_na: string;
  }

  let bloatData: TableBloatRow[] = [];
  let bloatError: string | null = null;

  try {
    const result = await client.query<TableBloatRow>(`
      select
        schemaname,
        tblname,
        (bs * tblpages)::bigint as real_size_bytes,
        pg_size_pretty((bs * tblpages)::bigint) as real_size_pretty,
        ((tblpages - est_tblpages) * bs)::bigint as extra_size_bytes,
        pg_size_pretty(((tblpages - est_tblpages) * bs)::bigint) as extra_size_pretty,
        case when tblpages > 0 and tblpages - est_tblpages > 0
          then round(100.0 * (tblpages - est_tblpages) / tblpages, 2)
          else 0
        end as extra_pct,
        fillfactor,
        case when tblpages - est_tblpages_ff > 0
          then ((tblpages - est_tblpages_ff) * bs)::bigint
          else 0
        end as bloat_size_bytes,
        pg_size_pretty(case when tblpages - est_tblpages_ff > 0
          then ((tblpages - est_tblpages_ff) * bs)::bigint
          else 0
        end) as bloat_size_pretty,
        case when tblpages > 0 and tblpages - est_tblpages_ff > 0
          then round(100.0 * (tblpages - est_tblpages_ff) / tblpages, 2)
          else 0
        end as bloat_pct,
        is_na::text
      from (
        select
          ceil(reltuples / ((bs - page_hdr) / tpl_size)) + ceil(toasttuples / 4) as est_tblpages,
          ceil(reltuples / ((bs - page_hdr) * fillfactor / (tpl_size * 100))) + ceil(toasttuples / 4) as est_tblpages_ff,
          tblpages, fillfactor, bs, schemaname, tblname, is_na
        from (
          select
            (4 + tpl_hdr_size + tpl_data_size + (2 * ma)
              - case when tpl_hdr_size % ma = 0 then ma else tpl_hdr_size % ma end
              - case when ceil(tpl_data_size)::int % ma = 0 then ma else ceil(tpl_data_size)::int % ma end
            ) as tpl_size,
            (heappages + toastpages) as tblpages,
            reltuples, toasttuples, bs, page_hdr, schemaname, tblname, fillfactor, is_na
          from (
            select
              ns.nspname as schemaname,
              tbl.relname as tblname,
              tbl.reltuples,
              tbl.relpages as heappages,
              coalesce(toast.relpages, 0) as toastpages,
              coalesce(toast.reltuples, 0) as toasttuples,
              coalesce(substring(array_to_string(tbl.reloptions, ' ') from 'fillfactor=([0-9]+)')::smallint, 100) as fillfactor,
              current_setting('block_size')::numeric as bs,
              case when version() ~ 'mingw32' or version() ~ '64-bit|x86_64|ppc64|ia64|amd64' then 8 else 4 end as ma,
              24 as page_hdr,
              23 + case when max(coalesce(s.null_frac, 0)) > 0 then (7 + count(s.attname)) / 8 else 0::int end
                + case when bool_or(att.attname = 'oid' and att.attnum < 0) then 4 else 0 end as tpl_hdr_size,
              sum((1 - coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 0)) as tpl_data_size,
              (bool_or(att.atttypid = 'pg_catalog.name'::regtype)
                or sum(case when att.attnum > 0 then 1 else 0 end) <> count(s.attname))::int as is_na
            from pg_attribute as att
              join pg_class as tbl on att.attrelid = tbl.oid
              join pg_namespace as ns on ns.oid = tbl.relnamespace
              left join pg_stats as s on s.schemaname = ns.nspname
                and s.tablename = tbl.relname and s.attname = att.attname
              left join pg_class as toast on tbl.reltoastrelid = toast.oid
            where not att.attisdropped
              and tbl.relkind in ('r', 'm')
              and ns.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
            group by ns.nspname, tbl.relname, tbl.reltuples, tbl.relpages, toast.relpages, toast.reltuples, tbl.reloptions
          ) as s
        ) as s2
      ) as s3
      where tblpages > 0 and (bs * tblpages) >= 1024 * 1024  -- exclude tables < 1 MiB
      order by bloat_size_bytes desc
      limit 100
    `);
    bloatData = result.rows;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[F004] Error estimating table bloat: ${errorMsg}`);
    bloatError = errorMsg;
  }

  report.results[nodeName] = {
    data: {
      tables: bloatData,
      ...(bloatError && { error: bloatError }),
    },
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate F005 report - Autovacuum: index bloat estimate
 *
 * Estimates B-tree index bloat based on statistical analysis of index pages vs expected pages.
 */
async function generateF005(client: Client, nodeName: string): Promise<Report> {
  const report = createBaseReport("F005", "Autovacuum: index bloat estimate", nodeName);
  const postgresVersion = await getPostgresVersion(client);

  interface IndexBloatRow {
    schemaname: string;
    tblname: string;
    idxname: string;
    real_size_bytes: string;
    real_size_pretty: string;
    table_size_bytes: string;
    table_size_pretty: string;
    extra_size_bytes: string;
    extra_size_pretty: string;
    extra_pct: string;
    fillfactor: string;
    bloat_size_bytes: string;
    bloat_size_pretty: string;
    bloat_pct: string;
    is_na: string;
  }

  let bloatData: IndexBloatRow[] = [];
  let bloatError: string | null = null;

  try {
    const result = await client.query<IndexBloatRow>(`
      select
        nspname as schemaname,
        tblname,
        idxname,
        (bs * relpages)::bigint as real_size_bytes,
        pg_size_pretty((bs * relpages)::bigint) as real_size_pretty,
        pg_relation_size(tbloid)::bigint as table_size_bytes,
        pg_size_pretty(pg_relation_size(tbloid)) as table_size_pretty,
        ((relpages - est_pages) * bs)::bigint as extra_size_bytes,
        pg_size_pretty(((relpages - est_pages) * bs)::bigint) as extra_size_pretty,
        round(100.0 * (relpages - est_pages) / relpages, 2) as extra_pct,
        fillfactor,
        case when relpages > est_pages_ff
          then ((relpages - est_pages_ff) * bs)::bigint
          else 0
        end as bloat_size_bytes,
        pg_size_pretty(case when relpages > est_pages_ff
          then ((relpages - est_pages_ff) * bs)::bigint
          else 0
        end) as bloat_size_pretty,
        case when relpages > est_pages_ff
          then round(100.0 * (relpages - est_pages_ff) / relpages, 2)
          else 0
        end as bloat_pct,
        is_na::text
      from (
        select
          coalesce(1 + ceil(reltuples / floor((bs - pageopqdata - pagehdr) / (4 + nulldatahdrwidth)::float)), 0) as est_pages,
          coalesce(1 + ceil(reltuples / floor((bs - pageopqdata - pagehdr) * fillfactor / (100 * (4 + nulldatahdrwidth)::float))), 0) as est_pages_ff,
          bs, nspname, tblname, idxname, relpages, fillfactor, is_na, tbloid
        from (
          select
            maxalign, bs, nspname, tblname, idxname, reltuples, relpages, idxoid, fillfactor, tbloid,
            (index_tuple_hdr_bm + maxalign
              - case when index_tuple_hdr_bm % maxalign = 0 then maxalign else index_tuple_hdr_bm % maxalign end
              + nulldatawidth + maxalign
              - case when nulldatawidth = 0 then 0
                     when nulldatawidth::integer % maxalign = 0 then maxalign
                     else nulldatawidth::integer % maxalign end
            )::numeric as nulldatahdrwidth,
            pagehdr, pageopqdata, is_na
          from (
            select
              n.nspname, i.tblname, i.idxname, i.reltuples, i.relpages, i.tbloid, i.idxoid, i.fillfactor,
              current_setting('block_size')::numeric as bs,
              case when version() ~ 'mingw32' or version() ~ '64-bit|x86_64|ppc64|ia64|amd64' then 8 else 4 end as maxalign,
              24 as pagehdr,
              16 as pageopqdata,
              case when max(coalesce(s.null_frac, 0)) = 0
                then 8
                else 8 + ((32 + 8 - 1) / 8)
              end as index_tuple_hdr_bm,
              sum((1 - coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 1024)) as nulldatawidth,
              (max(case when i.atttypid = 'pg_catalog.name'::regtype then 1 else 0 end) > 0)::int as is_na
            from (
              select
                ct.relname as tblname, ct.relnamespace, ic.idxname, ic.attpos, ic.indkey,
                ic.indkey[ic.attpos], ic.reltuples, ic.relpages, ic.tbloid, ic.idxoid, ic.fillfactor,
                coalesce(a1.attnum, a2.attnum) as attnum,
                coalesce(a1.attname, a2.attname) as attname,
                coalesce(a1.atttypid, a2.atttypid) as atttypid,
                case when a1.attnum is null then ic.idxname else ct.relname end as attrelname
              from (
                select
                  idxname, reltuples, relpages, tbloid, idxoid, fillfactor,
                  indkey, generate_subscripts(indkey, 1) as attpos
                from (
                  select
                    ci.relname as idxname, ci.reltuples, ci.relpages, i.indrelid as tbloid,
                    i.indexrelid as idxoid,
                    coalesce(substring(array_to_string(ci.reloptions, ' ') from 'fillfactor=([0-9]+)')::smallint, 90) as fillfactor,
                    i.indkey
                  from pg_index as i
                    join pg_class as ci on ci.oid = i.indexrelid
                    join pg_namespace as ns on ns.oid = ci.relnamespace
                    join pg_am as am on am.oid = ci.relam
                  where am.amname = 'btree'
                    and ci.relpages > 0
                    and ns.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
                ) as idx_data
              ) as ic
                join pg_class as ct on ct.oid = ic.tbloid
                left join pg_attribute as a1 on a1.attrelid = ic.idxoid and a1.attnum = ic.indkey[ic.attpos]
                left join pg_attribute as a2 on a2.attrelid = ic.tbloid and a2.attnum = ic.indkey[ic.attpos]
            ) as i
              join pg_namespace as n on n.oid = i.relnamespace
              left join pg_stats as s on s.schemaname = n.nspname
                and s.tablename = i.attrelname and s.attname = i.attname
            group by n.nspname, i.tblname, i.idxname, i.reltuples, i.relpages, i.tbloid, i.idxoid, i.fillfactor
          ) as rows_data_stats
        ) as rows_hdr_pdg_stats
      ) as relation_stats
      where relpages > 0 and (bs * relpages) >= 1024 * 1024  -- exclude indexes < 1 MiB
      order by bloat_size_bytes desc
      limit 100
    `);
    bloatData = result.rows;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[F005] Error estimating index bloat: ${errorMsg}`);
    bloatError = errorMsg;
  }

  report.results[nodeName] = {
    data: {
      indexes: bloatData,
      ...(bloatError && { error: bloatError }),
    },
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
  let memoryError: string | null = null;

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
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[G001] Error calculating memory usage: ${errorMsg}`);
    memoryError = errorMsg;
  }

  report.results[nodeName] = {
    data: {
      settings: memorySettings,
      analysis: {
        estimated_total_memory_usage: memoryUsage,
        ...(memoryError && { error: memoryError }),
      },
    },
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate G003 report - Timeouts, locks, deadlocks
 *
 * Collects timeout and lock-related settings, plus deadlock statistics.
 */
async function generateG003(client: Client, nodeName: string): Promise<Report> {
  const report = createBaseReport("G003", "Timeouts, locks, deadlocks", nodeName);
  const postgresVersion = await getPostgresVersion(client);
  const pgMajorVersion = parseInt(postgresVersion.server_major_ver, 10) || 16;
  const allSettings = await getSettings(client, pgMajorVersion);

  // Timeout and lock-related setting names
  const lockTimeoutSettingNames = [
    "lock_timeout",
    "statement_timeout",
    "idle_in_transaction_session_timeout",
    "idle_session_timeout",
    "deadlock_timeout",
    "max_locks_per_transaction",
    "max_pred_locks_per_transaction",
    "max_pred_locks_per_relation",
    "max_pred_locks_per_page",
    "log_lock_waits",
    "transaction_timeout",
  ];

  const lockSettings: Record<string, SettingInfo> = {};
  for (const name of lockTimeoutSettingNames) {
    if (allSettings[name]) {
      lockSettings[name] = allSettings[name];
    }
  }

  // Get deadlock statistics from pg_stat_database
  let deadlockStats: {
    deadlocks: number;
    conflicts: number;
    stats_reset: string | null;
  } | null = null;
  let deadlockError: string | null = null;

  try {
    const statsResult = await client.query(`
      select
        coalesce(sum(deadlocks), 0)::bigint as deadlocks,
        coalesce(sum(conflicts), 0)::bigint as conflicts,
        min(stats_reset)::text as stats_reset
      from pg_stat_database
      where datname = current_database()
    `);
    if (statsResult.rows.length > 0) {
      const row = statsResult.rows[0];
      deadlockStats = {
        deadlocks: parseInt(row.deadlocks, 10),
        conflicts: parseInt(row.conflicts, 10),
        stats_reset: row.stats_reset || null,
      };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[G003] Error querying deadlock stats: ${errorMsg}`);
    deadlockError = errorMsg;
  }

  report.results[nodeName] = {
    data: {
      settings: lockSettings,
      deadlock_stats: deadlockStats,
      ...(deadlockError && { deadlock_stats_error: deadlockError }),
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
  D001: generateD001,
  D004: generateD004,
  F001: generateF001,
  F004: generateF004,
  F005: generateF005,
  G001: generateG001,
  G003: generateG003,
  H001: generateH001,
  H002: generateH002,
  H004: generateH004,
};

/**
 * Check IDs and titles.
 *
 * This mapping is built from the embedded checkup dictionary, which is
 * fetched from https://postgres.ai/api/general/checkup_dictionary at build time.
 *
 * For the full dictionary (all available checks), use the checkup-dictionary module.
 * CHECK_INFO is filtered to only include checks that have express-mode generators.
 */
export const CHECK_INFO: Record<string, string> = (() => {
  // Build the full dictionary map
  const fullMap = buildCheckInfoMap();

  // Filter to only include checks that have express-mode generators
  const expressCheckIds = Object.keys(REPORT_GENERATORS);
  const filtered: Record<string, string> = {};
  for (const checkId of expressCheckIds) {
    // Use dictionary title if available, otherwise use a fallback
    filtered[checkId] = fullMap[checkId] || checkId;
  }
  return filtered;
})();

/**
 * Generate all available health check reports.
 * This is the main entry point for express mode checkup generation.
 *
 * @param client - Connected PostgreSQL client
 * @param nodeName - Node identifier for the report (default: "node-01")
 * @param onProgress - Optional callback for progress updates during generation
 * @returns Object mapping check IDs (e.g., "H001", "A002") to their reports
 * @throws {Error} If any critical report generation fails
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
