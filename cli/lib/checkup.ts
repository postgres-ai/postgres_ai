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
    select
      name,
      setting,
      coalesce(unit, '') as unit,
      category,
      context,
      vartype,
      case
        when unit = '8kB' then pg_size_pretty(setting::bigint * 8192)
        when unit = 'kB' then pg_size_pretty(setting::bigint * 1024)
        when unit = 'MB' then pg_size_pretty(setting::bigint * 1024 * 1024)
        when unit = 'B' then pg_size_pretty(setting::bigint)
        when unit = 'ms' then setting || ' ms'
        when unit = 's' then setting || ' s'
        when unit = 'min' then setting || ' min'
        else setting
      end as pretty_value,
      source,
      case when source <> 'default' then 0 else 1 end as is_default
    from pg_settings
    order by name
  `,

  // Altered settings - non-default values only (A007)
  alteredSettings: `
    select
      name,
      setting,
      coalesce(unit, '') as unit,
      category,
      case
        when unit = '8kB' then pg_size_pretty(setting::bigint * 8192)
        when unit = 'kB' then pg_size_pretty(setting::bigint * 1024)
        when unit = 'MB' then pg_size_pretty(setting::bigint * 1024 * 1024)
        when unit = 'B' then pg_size_pretty(setting::bigint)
        when unit = 'ms' then setting || ' ms'
        when unit = 's' then setting || ' s'
        when unit = 'min' then setting || ' min'
        else setting
      end as pretty_value
    from pg_settings
    where source <> 'default'
    order by name
  `,

  // Version info - extracts server_version and server_version_num
  version: `
    select
      name,
      setting
    from pg_settings
    where name in ('server_version', 'server_version_num')
  `,

  // Database sizes (A004)
  databaseSizes: `
    select
      datname,
      pg_database_size(datname) as size_bytes
    from pg_database
    where datistemplate = false
    order by size_bytes desc
  `,

  // Cluster statistics (A004)
  clusterStats: `
    select
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
    from pg_stat_database
    where datname is not null
  `,

  // Connection states (A004)
  connectionStates: `
    select
      coalesce(state, 'null') as state,
      count(*) as count
    from pg_stat_activity
    group by state
  `,

  // Uptime info (A004)
  uptimeInfo: `
    select
      pg_postmaster_start_time() as start_time,
      current_timestamp - pg_postmaster_start_time() as uptime
  `,

  // Invalid indexes (H001) - indexes where indisvalid = false
  // Matches H001.schema.json invalidIndex structure
  invalidIndexes: `
    with fk_indexes as (
      select
        n.nspname as schema_name,
        ci.relname as index_name,
        cr.relname as table_name,
        (confrelid::regclass)::text as fk_table_ref,
        array_to_string(indclass, ', ') as opclasses
      from pg_index i
      join pg_class ci on ci.oid = i.indexrelid and ci.relkind = 'i'
      join pg_class cr on cr.oid = i.indrelid and cr.relkind = 'r'
      join pg_namespace n on n.oid = ci.relnamespace
      join pg_constraint cn on cn.conrelid = cr.oid
      where cn.contype = 'f'
        and i.indisunique = false
    )
    select
      n.nspname as schema_name,
      t.relname as table_name,
      i.relname as index_name,
      coalesce(nullif(quote_ident(n.nspname), 'public') || '.', '') || quote_ident(t.relname) as relation_name,
      pg_relation_size(i.oid) as index_size_bytes,
      (
        select count(1) > 0
        from fk_indexes fi
        where fi.fk_table_ref = t.relname
          and fi.schema_name = n.nspname
      ) as supports_fk
    from pg_index idx
    join pg_class i on i.oid = idx.indexrelid
    join pg_class t on t.oid = idx.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where idx.indisvalid = false
      and n.nspname not in ('pg_catalog', 'information_schema')
    order by pg_relation_size(i.oid) desc
  `,

  // Unused indexes (H002) - indexes with zero scans, excluding unique/PK indexes
  // Matches H002.schema.json unusedIndex structure
  unusedIndexes: `
    with fk_indexes as (
      select
        n.nspname as schema_name,
        ci.relname as index_name,
        cr.relname as table_name,
        (confrelid::regclass)::text as fk_table_ref,
        array_to_string(indclass, ', ') as opclasses
      from pg_index i
      join pg_class ci on ci.oid = i.indexrelid and ci.relkind = 'i'
      join pg_class cr on cr.oid = i.indrelid and cr.relkind = 'r'
      join pg_namespace n on n.oid = ci.relnamespace
      join pg_constraint cn on cn.conrelid = cr.oid
      left join pg_stat_all_indexes si on si.indexrelid = i.indexrelid
      where cn.contype = 'f'
        and i.indisunique = false
        and cn.conkey is not null
        and ci.relpages > 0
        and coalesce(si.idx_scan, 0) < 10
    ),
    indexes as (
      select
        i.indrelid,
        i.indexrelid,
        n.nspname as schema_name,
        cr.relname as table_name,
        ci.relname as index_name,
        pg_get_indexdef(i.indexrelid) as index_definition,
        coalesce(si.idx_scan, 0) as idx_scan,
        pg_relation_size(i.indexrelid) as index_size_bytes,
        (case when a.amname = 'btree' then true else false end) as idx_is_btree,
        array_to_string(i.indclass, ', ') as opclasses
      from pg_index i
      join pg_class ci on ci.oid = i.indexrelid and ci.relkind = 'i'
      join pg_class cr on cr.oid = i.indrelid and cr.relkind = 'r'
      join pg_namespace n on n.oid = ci.relnamespace
      join pg_am a on ci.relam = a.oid
      left join pg_stat_all_indexes si on si.indexrelid = i.indexrelid
      where i.indisunique = false
        and i.indisvalid = true
        and ci.relpages > 0
        and n.nspname not in ('pg_catalog', 'information_schema')
    )
    select
      'Never Used Indexes' as reason,
      i.schema_name,
      i.table_name,
      i.index_name,
      i.index_definition,
      i.idx_scan,
      i.index_size_bytes,
      i.idx_is_btree,
      (
        select count(1) > 0
        from fk_indexes fi
        where fi.fk_table_ref = i.table_name
          and fi.schema_name = i.schema_name
          and fi.opclasses like (i.opclasses || '%')
      ) as supports_fk
    from indexes i
    where i.idx_scan = 0
      and i.idx_is_btree
    order by i.index_size_bytes desc
    limit 50
  `,

  // Stats reset info for H002
  statsReset: `
    select
      extract(epoch from stats_reset) as stats_reset_epoch,
      stats_reset::text as stats_reset_time,
      extract(day from (now() - stats_reset))::integer as days_since_reset,
      extract(epoch from pg_postmaster_start_time()) as postmaster_startup_epoch,
      pg_postmaster_start_time()::text as postmaster_startup_time
    from pg_stat_database
    where datname = current_database()
  `,

  // Redundant indexes (H004) - indexes covered by other indexes
  // Matches H004.schema.json redundantIndex structure
  redundantIndexes: `
    with fk_indexes as (
      select
        n.nspname as schema_name,
        ci.relname as index_name,
        cr.relname as table_name,
        (confrelid::regclass)::text as fk_table_ref,
        array_to_string(indclass, ', ') as opclasses
      from pg_index i
      join pg_class ci on ci.oid = i.indexrelid and ci.relkind = 'i'
      join pg_class cr on cr.oid = i.indrelid and cr.relkind = 'r'
      join pg_namespace n on n.oid = ci.relnamespace
      join pg_constraint cn on cn.conrelid = cr.oid
      left join pg_stat_all_indexes si on si.indexrelid = i.indexrelid
      where cn.contype = 'f'
        and i.indisunique = false
        and cn.conkey is not null
        and ci.relpages > 0
        and coalesce(si.idx_scan, 0) < 10
    ),
    index_data as (
      select
        i.*,
        ci.oid as index_oid,
        indkey::text as columns,
        array_to_string(indclass, ', ') as opclasses
      from pg_index i
      join pg_class ci on ci.oid = i.indexrelid and ci.relkind = 'i'
      where indisvalid = true
        and ci.relpages > 0
    ),
    redundant_indexes as (
      select
        i2.indexrelid as index_id,
        tnsp.nspname as schema_name,
        trel.relname as table_name,
        coalesce(nullif(quote_ident(tnsp.nspname), 'public') || '.', '') || quote_ident(trel.relname) as relation_name,
        pg_relation_size(trel.oid) as table_size_bytes,
        irel.relname as index_name,
        am1.amname as access_method,
        (i1.indexrelid::regclass)::text as reason,
        pg_relation_size(i2.indexrelid) as index_size_bytes,
        coalesce(s.idx_scan, 0) as index_usage,
        pg_get_indexdef(i2.indexrelid) as index_definition,
        i2.opclasses
      from (
        select indrelid, indexrelid, opclasses, indclass, indexprs, indpred, indisprimary, indisunique, columns
        from index_data
        order by indexrelid
      ) as i1
      join index_data as i2 on (
        i1.indrelid = i2.indrelid
        and i1.indexrelid <> i2.indexrelid
      )
      inner join pg_opclass op1 on i1.indclass[0] = op1.oid
      inner join pg_opclass op2 on i2.indclass[0] = op2.oid
      inner join pg_am am1 on op1.opcmethod = am1.oid
      inner join pg_am am2 on op2.opcmethod = am2.oid
      left join pg_stat_all_indexes s on s.indexrelid = i2.indexrelid
      join pg_class trel on trel.oid = i2.indrelid
      join pg_namespace tnsp on trel.relnamespace = tnsp.oid
      join pg_class irel on irel.oid = i2.indexrelid
      where not i2.indisprimary
        and not i2.indisunique
        and am1.amname = am2.amname
        and i1.columns like (i2.columns || '%')
        and i1.opclasses like (i2.opclasses || '%')
        and pg_get_expr(i1.indexprs, i1.indrelid) is not distinct from pg_get_expr(i2.indexprs, i2.indrelid)
        and pg_get_expr(i1.indpred, i1.indrelid) is not distinct from pg_get_expr(i2.indpred, i2.indrelid)
        and tnsp.nspname not in ('pg_catalog', 'information_schema')
    ),
    redundant_with_fk as (
      select
        ri.*,
        (
          select count(1) > 0
          from fk_indexes fi
          where fi.fk_table_ref = ri.table_name
            and fi.opclasses like (ri.opclasses || '%')
        ) as supports_fk
      from redundant_indexes ri
    ),
    numbered as (
      select row_number() over () as num, r.*
      from redundant_with_fk r
    ),
    with_links as (
      select
        n1.*,
        n2.num as r_num
      from numbered n1
      left join numbered n2 on n2.index_id = (
        select indexrelid from pg_index where indexrelid::regclass::text = n1.reason
      ) and (
        select indexrelid from pg_index where indexrelid::regclass::text = n2.reason
      ) = n1.index_id
    ),
    deduped as (
      select * from with_links
      where num < r_num
        or r_num is null
    )
    select distinct on (index_id)
      schema_name,
      table_name,
      index_name,
      relation_name,
      access_method,
      reason,
      index_size_bytes,
      table_size_bytes,
      index_usage,
      supports_fk,
      index_definition
    from deduped
    order by index_id, index_size_bytes desc
    limit 50
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
    relation_name: row.relation_name,
    index_size_bytes: parseInt(row.index_size_bytes, 10) || 0,
    index_size_pretty: formatBytes(parseInt(row.index_size_bytes, 10) || 0),
    supports_fk: row.supports_fk === true || row.supports_fk === "t",
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
    index_definition: row.index_definition || "",
    reason: row.reason,
    idx_scan: parseInt(row.idx_scan, 10) || 0,
    index_size_bytes: parseInt(row.index_size_bytes, 10) || 0,
    idx_is_btree: row.idx_is_btree === true || row.idx_is_btree === "t",
    supports_fk: row.supports_fk === true || row.supports_fk === "t",
    index_size_pretty: formatBytes(parseInt(row.index_size_bytes, 10) || 0),
  }));
}

/**
 * Get stats reset info (H002)
 */
export async function getStatsReset(client: Client): Promise<StatsReset> {
  const result = await client.query(METRICS_SQL.statsReset);
  const row = result.rows[0] || {};
  return {
    stats_reset_epoch: row.stats_reset_epoch ? parseFloat(row.stats_reset_epoch) : null,
    stats_reset_time: row.stats_reset_time || null,
    days_since_reset: row.days_since_reset ? parseInt(row.days_since_reset, 10) : null,
    postmaster_startup_epoch: row.postmaster_startup_epoch ? parseFloat(row.postmaster_startup_epoch) : null,
    postmaster_startup_time: row.postmaster_startup_time || null,
  };
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
    relation_name: row.relation_name,
    access_method: row.access_method,
    reason: row.reason,
    index_size_bytes: parseInt(row.index_size_bytes, 10) || 0,
    table_size_bytes: parseInt(row.table_size_bytes, 10) || 0,
    index_usage: parseInt(row.index_usage, 10) || 0,
    supports_fk: row.supports_fk === true || row.supports_fk === "t",
    index_definition: row.index_definition || "",
    index_size_pretty: formatBytes(parseInt(row.index_size_bytes, 10) || 0),
    table_size_pretty: formatBytes(parseInt(row.table_size_bytes, 10) || 0),
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
  
  // Get current database name and size
  const dbResult = await client.query("SELECT current_database() as datname, pg_database_size(current_database()) as size_bytes");
  const dbName = dbResult.rows[0]?.datname || "postgres";
  const dbSizeBytes = parseInt(dbResult.rows[0]?.size_bytes, 10) || 0;

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
  const unusedIndexes = await getUnusedIndexes(client);
  const postgresVersion = await getPostgresVersion(client);
  const statsReset = await getStatsReset(client);
  
  // Get current database name and size
  const dbResult = await client.query("SELECT current_database() as datname, pg_database_size(current_database()) as size_bytes");
  const dbName = dbResult.rows[0]?.datname || "postgres";
  const dbSizeBytes = parseInt(dbResult.rows[0]?.size_bytes, 10) || 0;

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
  const redundantIndexes = await getRedundantIndexes(client);
  const postgresVersion = await getPostgresVersion(client);
  
  // Get current database name and size
  const dbResult = await client.query("SELECT current_database() as datname, pg_database_size(current_database()) as size_bytes");
  const dbName = dbResult.rows[0]?.datname || "postgres";
  const dbSizeBytes = parseInt(dbResult.rows[0]?.size_bytes, 10) || 0;

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
