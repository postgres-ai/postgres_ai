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
 * Invalid index entry (H001)
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
 * Unused index entry (H002)
 */
export interface UnusedIndex {
  schema_name: string;
  table_name: string;
  index_name: string;
  reason: string;
  index_size_bytes: number;
  index_size_pretty: string;
  idx_scan: number;
  all_scans: number;
  index_scan_pct: number;
  writes: number;
  scans_per_write: number;
  table_size_bytes: number;
  table_size_pretty: string;
  supports_fk: boolean;
}

/**
 * Non-indexed foreign key entry (H003)
 */
export interface NonIndexedForeignKey {
  schema_name: string;
  table_name: string;
  fk_name: string;
  fk_definition: string;
  table_size_bytes: number;
  table_size_pretty: string;
  referenced_table: string;
}

/**
 * Redundant index entry (H004)
 */
export interface RedundantIndex {
  schema_name: string;
  table_name: string;
  index_name: string;
  access_method: string;
  reason: string;
  index_size_bytes: number;
  index_size_pretty: string;
  table_size_bytes: number;
  table_size_pretty: string;
  index_usage: number;
  supports_fk: boolean;
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

  // Invalid indexes (H001) - indexes where indisvalid = false
  invalidIndexes: `
    SELECT
      n.nspname as schema_name,
      t.relname as table_name,
      i.relname as index_name,
      pg_relation_size(i.oid) as index_size_bytes
    FROM pg_index idx
    JOIN pg_class i ON i.oid = idx.indexrelid
    JOIN pg_class t ON t.oid = idx.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE idx.indisvalid = false
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY pg_relation_size(i.oid) DESC
  `,

  // Unused indexes (H002) - indexes with zero scans, excluding unique/PK indexes
  unusedIndexes: `
    WITH fk_indexes AS (
      SELECT
        n.nspname as schema_name,
        ci.relname as index_name,
        cr.relname as table_name,
        (confrelid::regclass)::text as fk_table_ref,
        array_to_string(indclass, ', ') as opclasses
      FROM pg_index i
      JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relkind = 'i'
      JOIN pg_class cr ON cr.oid = i.indrelid AND cr.relkind = 'r'
      JOIN pg_namespace n ON n.oid = ci.relnamespace
      JOIN pg_constraint cn ON cn.conrelid = cr.oid
      LEFT JOIN pg_stat_all_indexes si ON si.indexrelid = i.indexrelid
      WHERE cn.contype = 'f'
        AND i.indisunique = false
        AND cn.conkey IS NOT NULL
        AND ci.relpages > 0
        AND COALESCE(si.idx_scan, 0) < 10
    ),
    table_scans AS (
      SELECT
        relid,
        COALESCE(idx_scan, 0) + COALESCE(seq_scan, 0) as all_scans,
        COALESCE(n_tup_ins, 0) + COALESCE(n_tup_upd, 0) + COALESCE(n_tup_del, 0) as writes,
        pg_relation_size(relid) as table_size
      FROM pg_stat_all_tables
      JOIN pg_class c ON c.oid = relid
      WHERE c.relpages > 0
    ),
    indexes AS (
      SELECT
        i.indrelid,
        i.indexrelid,
        n.nspname as schema_name,
        cr.relname as table_name,
        ci.relname as index_name,
        COALESCE(si.idx_scan, 0) as idx_scan,
        pg_relation_size(i.indexrelid) as index_size_bytes,
        ci.relpages,
        (CASE WHEN a.amname = 'btree' THEN true ELSE false END) as idx_is_btree,
        array_to_string(i.indclass, ', ') as opclasses
      FROM pg_index i
      JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relkind = 'i'
      JOIN pg_class cr ON cr.oid = i.indrelid AND cr.relkind = 'r'
      JOIN pg_namespace n ON n.oid = ci.relnamespace
      JOIN pg_am a ON ci.relam = a.oid
      LEFT JOIN pg_stat_all_indexes si ON si.indexrelid = i.indexrelid
      WHERE i.indisunique = false
        AND i.indisvalid = true
        AND ci.relpages > 0
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    )
    SELECT
      'Never Used Indexes' as reason,
      i.schema_name,
      i.table_name,
      i.index_name,
      i.idx_scan,
      ts.all_scans,
      ROUND((CASE WHEN ts.all_scans = 0 THEN 0.0 ELSE i.idx_scan::numeric / ts.all_scans * 100 END)::numeric, 2) as index_scan_pct,
      ts.writes,
      ROUND((CASE WHEN ts.writes = 0 THEN i.idx_scan::numeric ELSE i.idx_scan::numeric / ts.writes END)::numeric, 2) as scans_per_write,
      i.index_size_bytes,
      ts.table_size as table_size_bytes,
      i.relpages,
      i.idx_is_btree,
      (
        SELECT COUNT(1) > 0
        FROM fk_indexes fi
        WHERE fi.fk_table_ref = i.table_name
          AND fi.schema_name = i.schema_name
          AND fi.opclasses LIKE (i.opclasses || '%')
      ) as supports_fk
    FROM indexes i
    JOIN table_scans ts ON ts.relid = i.indrelid
    WHERE i.idx_scan = 0
      AND i.idx_is_btree
    ORDER BY i.index_size_bytes DESC
    LIMIT 50
  `,

  // Non-indexed foreign keys (H003)
  nonIndexedForeignKeys: `
    WITH fk_list AS (
      SELECT
        n.nspname as schema_name,
        t.relname as table_name,
        c.conname as fk_name,
        pg_get_constraintdef(c.oid) as fk_definition,
        c.conkey as fk_columns,
        c.confrelid as ref_table_oid
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'f'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ),
    indexed_fks AS (
      SELECT DISTINCT
        fk.schema_name,
        fk.table_name,
        fk.fk_name
      FROM fk_list fk
      JOIN pg_index idx ON idx.indrelid = (
        SELECT oid FROM pg_class 
        WHERE relname = fk.table_name 
          AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = fk.schema_name)
      )
      WHERE fk.fk_columns::text[] <@ (
        SELECT array_agg(a ORDER BY ord)
        FROM unnest(idx.indkey) WITH ORDINALITY AS u(a, ord)
        WHERE a != 0
      )
    )
    SELECT
      fk.schema_name,
      fk.table_name,
      fk.fk_name,
      fk.fk_definition,
      pg_relation_size(t.oid) as table_size_bytes,
      (SELECT relname FROM pg_class WHERE oid = fk.ref_table_oid) as referenced_table
    FROM fk_list fk
    JOIN pg_class t ON t.relname = fk.table_name
      AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = fk.schema_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM indexed_fks ifk
      WHERE ifk.schema_name = fk.schema_name
        AND ifk.table_name = fk.table_name
        AND ifk.fk_name = fk.fk_name
    )
    ORDER BY pg_relation_size(t.oid) DESC
    LIMIT 50
  `,

  // Redundant indexes (H004) - indexes covered by other indexes
  redundantIndexes: `
    WITH fk_indexes AS (
      SELECT
        n.nspname as schema_name,
        ci.relname as index_name,
        cr.relname as table_name,
        (confrelid::regclass)::text as fk_table_ref,
        array_to_string(indclass, ', ') as opclasses
      FROM pg_index i
      JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relkind = 'i'
      JOIN pg_class cr ON cr.oid = i.indrelid AND cr.relkind = 'r'
      JOIN pg_namespace n ON n.oid = ci.relnamespace
      JOIN pg_constraint cn ON cn.conrelid = cr.oid
      LEFT JOIN pg_stat_all_indexes si ON si.indexrelid = i.indexrelid
      WHERE cn.contype = 'f'
        AND i.indisunique = false
        AND cn.conkey IS NOT NULL
        AND ci.relpages > 0
        AND COALESCE(si.idx_scan, 0) < 10
    ),
    index_data AS (
      SELECT
        i.*,
        ci.oid as index_oid,
        indkey::text as columns,
        array_to_string(indclass, ', ') as opclasses
      FROM pg_index i
      JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relkind = 'i'
      WHERE indisvalid = true AND ci.relpages > 0
    ),
    redundant_indexes AS (
      SELECT
        i2.indexrelid as index_id,
        tnsp.nspname as schema_name,
        trel.relname as table_name,
        pg_relation_size(trel.oid) as table_size_bytes,
        irel.relname as index_name,
        am1.amname as access_method,
        (i1.indexrelid::regclass)::text as reason,
        pg_relation_size(i2.indexrelid) as index_size_bytes,
        COALESCE(s.idx_scan, 0) as index_usage,
        i2.opclasses
      FROM (
        SELECT indrelid, indexrelid, opclasses, indclass, indexprs, indpred, indisprimary, indisunique, columns
        FROM index_data
        ORDER BY indexrelid
      ) AS i1
      JOIN index_data AS i2 ON (
        i1.indrelid = i2.indrelid
        AND i1.indexrelid <> i2.indexrelid
      )
      INNER JOIN pg_opclass op1 ON i1.indclass[0] = op1.oid
      INNER JOIN pg_opclass op2 ON i2.indclass[0] = op2.oid
      INNER JOIN pg_am am1 ON op1.opcmethod = am1.oid
      INNER JOIN pg_am am2 ON op2.opcmethod = am2.oid
      LEFT JOIN pg_stat_all_indexes s ON s.indexrelid = i2.indexrelid
      JOIN pg_class trel ON trel.oid = i2.indrelid
      JOIN pg_namespace tnsp ON trel.relnamespace = tnsp.oid
      JOIN pg_class irel ON irel.oid = i2.indexrelid
      WHERE NOT i2.indisprimary
        AND NOT i2.indisunique
        AND am1.amname = am2.amname
        AND i1.columns LIKE (i2.columns || '%')
        AND i1.opclasses LIKE (i2.opclasses || '%')
        AND pg_get_expr(i1.indexprs, i1.indrelid) IS NOT DISTINCT FROM pg_get_expr(i2.indexprs, i2.indrelid)
        AND pg_get_expr(i1.indpred, i1.indrelid) IS NOT DISTINCT FROM pg_get_expr(i2.indpred, i2.indrelid)
        AND tnsp.nspname NOT IN ('pg_catalog', 'information_schema')
    ),
    redundant_with_fk AS (
      SELECT
        ri.*,
        (
          SELECT COUNT(1) > 0
          FROM fk_indexes fi
          WHERE fi.fk_table_ref = ri.table_name
            AND fi.opclasses LIKE (ri.opclasses || '%')
        ) as supports_fk
      FROM redundant_indexes ri
    ),
    numbered AS (
      SELECT ROW_NUMBER() OVER () as num, r.*
      FROM redundant_with_fk r
    ),
    with_links AS (
      SELECT
        n1.*,
        n2.num as r_num
      FROM numbered n1
      LEFT JOIN numbered n2 ON n2.index_id = (
        SELECT indexrelid FROM pg_index WHERE indexrelid::regclass::text = n1.reason
      ) AND (
        SELECT indexrelid FROM pg_index WHERE indexrelid::regclass::text = n2.reason
      ) = n1.index_id
    ),
    deduped AS (
      SELECT * FROM with_links
      WHERE num < r_num OR r_num IS NULL
    )
    SELECT DISTINCT ON (index_id)
      schema_name,
      table_name,
      index_name,
      access_method,
      reason,
      index_size_bytes,
      table_size_bytes,
      index_usage,
      supports_fk
    FROM deduped
    ORDER BY index_id, index_size_bytes DESC
    LIMIT 50
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
 * Get invalid indexes (H001)
 */
export async function getInvalidIndexes(client: Client): Promise<InvalidIndex[]> {
  const result = await client.query(METRICS_SQL.invalidIndexes);
  return result.rows.map((row) => ({
    schema_name: row.schema_name,
    table_name: row.table_name,
    index_name: row.index_name,
    relation_name: `${row.schema_name}.${row.table_name}`,
    index_size_bytes: parseInt(row.index_size_bytes, 10) || 0,
    index_size_pretty: formatBytes(parseInt(row.index_size_bytes, 10) || 0),
    supports_fk: false, // Invalid indexes don't support FK lookups
  }));
}

/**
 * Get unused indexes (H002)
 */
export async function getUnusedIndexes(client: Client): Promise<UnusedIndex[]> {
  const result = await client.query(METRICS_SQL.unusedIndexes);
  return result.rows.map((row) => ({
    schema_name: row.schema_name,
    table_name: row.table_name,
    index_name: row.index_name,
    reason: row.reason,
    index_size_bytes: parseInt(row.index_size_bytes, 10) || 0,
    index_size_pretty: formatBytes(parseInt(row.index_size_bytes, 10) || 0),
    idx_scan: parseInt(row.idx_scan, 10) || 0,
    all_scans: parseInt(row.all_scans, 10) || 0,
    index_scan_pct: parseFloat(row.index_scan_pct) || 0,
    writes: parseInt(row.writes, 10) || 0,
    scans_per_write: parseFloat(row.scans_per_write) || 0,
    table_size_bytes: parseInt(row.table_size_bytes, 10) || 0,
    table_size_pretty: formatBytes(parseInt(row.table_size_bytes, 10) || 0),
    supports_fk: row.supports_fk === true || row.supports_fk === "t",
  }));
}

/**
 * Get non-indexed foreign keys (H003)
 */
export async function getNonIndexedForeignKeys(client: Client): Promise<NonIndexedForeignKey[]> {
  const result = await client.query(METRICS_SQL.nonIndexedForeignKeys);
  return result.rows.map((row) => ({
    schema_name: row.schema_name,
    table_name: row.table_name,
    fk_name: row.fk_name,
    fk_definition: row.fk_definition,
    table_size_bytes: parseInt(row.table_size_bytes, 10) || 0,
    table_size_pretty: formatBytes(parseInt(row.table_size_bytes, 10) || 0),
    referenced_table: row.referenced_table,
  }));
}

/**
 * Get redundant indexes (H004)
 */
export async function getRedundantIndexes(client: Client): Promise<RedundantIndex[]> {
  const result = await client.query(METRICS_SQL.redundantIndexes);
  return result.rows.map((row) => ({
    schema_name: row.schema_name,
    table_name: row.table_name,
    index_name: row.index_name,
    access_method: row.access_method,
    reason: row.reason,
    index_size_bytes: parseInt(row.index_size_bytes, 10) || 0,
    index_size_pretty: formatBytes(parseInt(row.index_size_bytes, 10) || 0),
    table_size_bytes: parseInt(row.table_size_bytes, 10) || 0,
    table_size_pretty: formatBytes(parseInt(row.table_size_bytes, 10) || 0),
    index_usage: parseInt(row.index_usage, 10) || 0,
    supports_fk: row.supports_fk === true || row.supports_fk === "t",
  }));
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
 * Generate H001 report - Invalid indexes
 */
export async function generateH001(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("H001", "Invalid indexes", nodeName);
  const invalidIndexes = await getInvalidIndexes(client);
  const postgresVersion = await getPostgresVersion(client);

  // Calculate totals
  const totalCount = invalidIndexes.length;
  const totalSizeBytes = invalidIndexes.reduce((sum, idx) => sum + idx.index_size_bytes, 0);

  report.results[nodeName] = {
    data: {
      invalid_indexes: invalidIndexes,
      total_count: totalCount,
      total_size_bytes: totalSizeBytes,
      total_size_pretty: formatBytes(totalSizeBytes),
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
  const unusedIndexes = await getUnusedIndexes(client);
  const postgresVersion = await getPostgresVersion(client);

  // Calculate totals
  const totalCount = unusedIndexes.length;
  const totalSizeBytes = unusedIndexes.reduce((sum, idx) => sum + idx.index_size_bytes, 0);

  report.results[nodeName] = {
    data: {
      unused_indexes: unusedIndexes,
      total_count: totalCount,
      total_size_bytes: totalSizeBytes,
      total_size_pretty: formatBytes(totalSizeBytes),
    },
    postgres_version: postgresVersion,
  };

  return report;
}

/**
 * Generate H003 report - Non-indexed foreign keys
 */
export async function generateH003(client: Client, nodeName: string = "node-01"): Promise<Report> {
  const report = createBaseReport("H003", "Non-indexed foreign keys", nodeName);
  const nonIndexedFKs = await getNonIndexedForeignKeys(client);
  const postgresVersion = await getPostgresVersion(client);

  // Calculate totals
  const totalCount = nonIndexedFKs.length;

  report.results[nodeName] = {
    data: {
      non_indexed_fks: nonIndexedFKs,
      total_count: totalCount,
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
  const redundantIndexes = await getRedundantIndexes(client);
  const postgresVersion = await getPostgresVersion(client);

  // Calculate totals
  const totalCount = redundantIndexes.length;
  const totalSizeBytes = redundantIndexes.reduce((sum, idx) => sum + idx.index_size_bytes, 0);

  report.results[nodeName] = {
    data: {
      redundant_indexes: redundantIndexes,
      total_count: totalCount,
      total_size_bytes: totalSizeBytes,
      total_size_pretty: formatBytes(totalSizeBytes),
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
  H001: generateH001,
  H002: generateH002,
  H003: generateH003,
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
  H001: "Invalid indexes",
  H002: "Unused indexes",
  H003: "Non-indexed foreign keys",
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
