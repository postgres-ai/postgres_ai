/**
 * Embedded SQL queries for express checkup reports
 * 
 * IMPORTANT: These SQL queries are extracted from config/pgwatch-prometheus/metrics.yml
 * and embedded here for the CLI npm package to work without external dependencies.
 * 
 * When updating queries, ensure both this file AND metrics.yml are kept in sync.
 * The metrics.yml remains the source of truth for the monitoring stack.
 */

/**
 * Embedded SQL queries for each metric.
 * Keys are metric names, values are SQL query strings.
 */
const EMBEDDED_SQL: Record<string, string> = {
  // =========================================================================
  // EXPRESS REPORTS - Simple settings and version queries
  // =========================================================================
  
  express_version: `
select
  name,
  setting
from pg_settings
where name in ('server_version', 'server_version_num');
`,

  express_settings: `
select
  name,
  setting,
  unit,
  category,
  context,
  vartype,
  case when (source <> 'default') then 0 else 1 end as is_default,
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
order by name;
`,

  express_altered_settings: `
select
  name,
  setting,
  unit,
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
order by name;
`,

  express_database_sizes: `
select
  datname,
  pg_database_size(datname) as size_bytes
from pg_database
where datistemplate = false
order by size_bytes desc;
`,

  express_cluster_stats: `
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
where datname is not null;
`,

  express_connection_states: `
select
  coalesce(state, 'null') as state,
  count(*) as count
from pg_stat_activity
group by state;
`,

  express_uptime: `
select
  pg_postmaster_start_time() as start_time,
  current_timestamp - pg_postmaster_start_time() as uptime;
`,

  express_stats_reset: `
select
  extract(epoch from stats_reset) as stats_reset_epoch,
  stats_reset::text as stats_reset_time,
  extract(day from (now() - stats_reset))::integer as days_since_reset,
  extract(epoch from pg_postmaster_start_time()) as postmaster_startup_epoch,
  pg_postmaster_start_time()::text as postmaster_startup_time
from pg_stat_database
where datname = current_database();
`,

  express_current_database: `
select
  current_database() as datname,
  pg_database_size(current_database()) as size_bytes;
`,

  // =========================================================================
  // INDEX HEALTH REPORTS - H001, H002, H004
  // =========================================================================

  pg_invalid_indexes: `
with fk_indexes as (
  select
    schemaname as tag_schema_name,
    (indexrelid::regclass)::text as tag_index_name,
    (relid::regclass)::text as tag_table_name,
    (confrelid::regclass)::text as tag_fk_table_ref,
    array_to_string(indclass, ', ') as tag_opclasses
  from
    pg_stat_all_indexes
  join pg_index using (indexrelid)
  left join pg_constraint
    on array_to_string(indkey, ',') = array_to_string(conkey, ',')
      and schemaname = (connamespace::regnamespace)::text
      and conrelid = relid
      and contype = 'f'
  where idx_scan = 0
    and indisunique is false
    and conkey is not null
), data as (
  select
    pci.relname as tag_index_name,
    pn.nspname as tag_schema_name,
    pct.relname as tag_table_name,
    quote_ident(pn.nspname) as tag_schema_name,
    quote_ident(pci.relname) as tag_index_name,
    quote_ident(pct.relname) as tag_table_name,
    coalesce(nullif(quote_ident(pn.nspname), 'public') || '.', '') || quote_ident(pct.relname) as tag_relation_name,
    pg_relation_size(pidx.indexrelid) index_size_bytes,
    ((
      select count(1)
      from fk_indexes fi
      where
        fi.tag_fk_table_ref = pct.relname
        and fi.tag_opclasses like (array_to_string(pidx.indclass, ', ') || '%')
    ) > 0)::int as supports_fk
  from pg_index pidx
  join pg_class as pci on pci.oid = pidx.indexrelid
  join pg_class as pct on pct.oid = pidx.indrelid
  left join pg_namespace pn on pn.oid = pct.relnamespace
  where pidx.indisvalid = false
), data_total as (
    select
      sum(index_size_bytes) as index_size_bytes_sum
    from data
), num_data as (
  select
    row_number() over () num,
    data.*
  from data
)
select
  (extract(epoch from now()) * 1e9)::int8 as epoch_ns,
  current_database() as tag_datname,
  num_data.*
from num_data
limit 1000;
`,

  unused_indexes: `
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
  left join pg_stat_all_indexes as si on si.indexrelid = i.indexrelid
  where
    contype = 'f'
    and i.indisunique is false
    and conkey is not null
    and ci.relpages > 5
    and si.idx_scan < 10
), table_scans as (
  select relid,
      tables.idx_scan + tables.seq_scan as all_scans,
      ( tables.n_tup_ins + tables.n_tup_upd + tables.n_tup_del ) as writes,
    pg_relation_size(relid) as table_size
      from pg_stat_all_tables as tables
      join pg_class c on c.oid = relid
      where c.relpages > 5
), indexes as (
  select
    i.indrelid,
    i.indexrelid,
    n.nspname as schema_name,
    cr.relname as table_name,
    ci.relname as index_name,
    si.idx_scan,
    pg_relation_size(i.indexrelid) as index_bytes,
    ci.relpages,
    (case when a.amname = 'btree' then true else false end) as idx_is_btree,
    array_to_string(i.indclass, ', ') as opclasses
  from pg_index i
    join pg_class ci on ci.oid = i.indexrelid and ci.relkind = 'i'
    join pg_class cr on cr.oid = i.indrelid and cr.relkind = 'r'
    join pg_namespace n on n.oid = ci.relnamespace
    join pg_am a on ci.relam = a.oid
    left join pg_stat_all_indexes as si on si.indexrelid = i.indexrelid
  where
    i.indisunique = false
    and i.indisvalid = true
    and ci.relpages > 5
), index_ratios as (
  select
    i.indexrelid as index_id,
    i.schema_name,
    i.table_name,
    i.index_name,
    idx_scan,
    all_scans,
    round(( case when all_scans = 0 then 0.0::numeric
      else idx_scan::numeric/all_scans * 100 end), 2) as index_scan_pct,
    writes,
    round((case when writes = 0 then idx_scan::numeric else idx_scan::numeric/writes end), 2)
      as scans_per_write,
    index_bytes as index_size_bytes,
    table_size as table_size_bytes,
    i.relpages,
    idx_is_btree,
    i.opclasses,
    (
      select count(1)
      from fk_indexes fi
      where fi.fk_table_ref = i.table_name
        and fi.schema_name = i.schema_name
        and fi.opclasses like (i.opclasses || '%')
    ) > 0 as supports_fk
  from indexes i
  join table_scans ts on ts.relid = i.indrelid
)
select
  'Never Used Indexes' as tag_reason,
  current_database() as tag_datname,
  index_id,
  schema_name as tag_schema_name,
  table_name as tag_table_name,
  index_name as tag_index_name,
  pg_get_indexdef(index_id) as index_definition,
  idx_scan,
  all_scans,
  index_scan_pct,
  writes,
  scans_per_write,
  index_size_bytes,
  table_size_bytes,
  relpages,
  idx_is_btree,
  opclasses as tag_opclasses,
  supports_fk
from index_ratios
where
  idx_scan = 0
  and idx_is_btree
order by index_size_bytes desc
limit 1000;
`,

  redundant_indexes: `
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
  left join pg_stat_all_indexes as si on si.indexrelid = i.indexrelid
  where
    contype = 'f'
    and i.indisunique is false
    and conkey is not null
    and ci.relpages > 5
    and si.idx_scan < 10
),
index_data as (
  select
    *,
    indkey::text as columns,
    array_to_string(indclass, ', ') as opclasses
  from pg_index i
  join pg_class ci on ci.oid = i.indexrelid and ci.relkind = 'i'
  where indisvalid = true and ci.relpages > 5
), redundant_indexes as (
  select
    i2.indexrelid as index_id,
    tnsp.nspname as schema_name,
    trel.relname as table_name,
    pg_relation_size(trel.oid) as table_size_bytes,
    irel.relname as index_name,
    am1.amname as access_method,
    (i1.indexrelid::regclass)::text as reason,
    i1.indexrelid as reason_index_id,
    pg_get_indexdef(i1.indexrelid) main_index_def,
    pg_size_pretty(pg_relation_size(i1.indexrelid)) main_index_size,
    pg_get_indexdef(i2.indexrelid) index_def,
    pg_relation_size(i2.indexrelid) index_size_bytes,
    s.idx_scan as index_usage,
    quote_ident(tnsp.nspname) as formated_schema_name,
    coalesce(nullif(quote_ident(tnsp.nspname), 'public') || '.', '') || quote_ident(irel.relname) as formated_index_name,
    quote_ident(trel.relname) as formated_table_name,
    coalesce(nullif(quote_ident(tnsp.nspname), 'public') || '.', '') || quote_ident(trel.relname) as formated_relation_name,
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
    join pg_stat_all_indexes as s on s.indexrelid = i2.indexrelid
    join pg_class as trel on trel.oid = i2.indrelid
    join pg_namespace as tnsp on trel.relnamespace = tnsp.oid
    join pg_class as irel on irel.oid = i2.indexrelid
  where
    not i2.indisprimary
    and not i2.indisunique
    and  am1.amname = am2.amname
    and i1.columns like (i2.columns || '%')
    and i1.opclasses like (i2.opclasses || '%')
    and pg_get_expr(i1.indexprs, i1.indrelid) is not distinct from pg_get_expr(i2.indexprs, i2.indrelid)
    and pg_get_expr(i1.indpred, i1.indrelid) is not distinct from pg_get_expr(i2.indpred, i2.indrelid)
), redundant_indexes_fk as (
  select
    ri.*,
    ((
      select count(1)
      from fk_indexes fi
      where
        fi.fk_table_ref = ri.table_name
        and fi.opclasses like (ri.opclasses || '%')
    ) > 0)::int as supports_fk
  from redundant_indexes ri
),
redundant_indexes_tmp_num as (
  select row_number() over () num, rig.*
  from redundant_indexes_fk rig
), redundant_indexes_tmp_links as (
    select
    ri1.*,
    ri2.num as r_num
    from redundant_indexes_tmp_num ri1
    left join redundant_indexes_tmp_num ri2 on ri2.reason_index_id = ri1.index_id and ri1.reason_index_id = ri2.index_id
), redundant_indexes_tmp_cut as (
    select
    *
    from redundant_indexes_tmp_links
    where num < r_num or r_num is null
), redundant_indexes_cut_grouped as (
  select
    distinct(num),
    *
  from redundant_indexes_tmp_cut
  order by index_size_bytes desc
), redundant_indexes_grouped as (
  select
    index_id,
    schema_name as tag_schema_name,
    table_name,
    table_size_bytes,
    index_name as tag_index_name,
    access_method as tag_access_method,
    string_agg(distinct reason, ', ') as tag_reason,
    index_size_bytes,
    index_usage,
    index_def as index_definition,
    formated_index_name as tag_index_name,
    formated_schema_name as tag_schema_name,
    formated_table_name as tag_table_name,
    formated_relation_name as tag_relation_name,
    supports_fk::int as supports_fk,
    json_agg(
      distinct jsonb_build_object(
        'index_name', reason,
        'index_definition', main_index_def
      )
    )::text as main_indexes_json
  from redundant_indexes_cut_grouped
  group by
    index_id,
    table_size_bytes,
    schema_name,
    table_name,
    index_name,
    access_method,
    index_def,
    index_size_bytes,
    index_usage,
    formated_index_name,
    formated_schema_name,
    formated_table_name,
    formated_relation_name,
    supports_fk
  order by index_size_bytes desc
)
select * from redundant_indexes_grouped
limit 1000;
`,
};

/**
 * Get SQL query for a specific metric.
 * 
 * @param metricName - Name of the metric (e.g., "pg_invalid_indexes", "express_version")
 * @param _pgMajorVersion - PostgreSQL major version (currently unused, for future version-specific queries)
 * @returns SQL query string
 */
export function getMetricSql(metricName: string, _pgMajorVersion: number = 16): string {
  const sql = EMBEDDED_SQL[metricName];
  
  if (!sql) {
    throw new Error(`Metric "${metricName}" not found. Available metrics: ${Object.keys(EMBEDDED_SQL).join(", ")}`);
  }
  
  return sql;
}

/**
 * Metric names that correspond to express report checks.
 * These map check IDs to metric names in the EMBEDDED_SQL object.
 */
export const METRIC_NAMES = {
  // Index health checks
  H001: "pg_invalid_indexes",
  H002: "unused_indexes", 
  H004: "redundant_indexes",
  // Express report metrics
  version: "express_version",
  settings: "express_settings",
  alteredSettings: "express_altered_settings",
  databaseSizes: "express_database_sizes",
  clusterStats: "express_cluster_stats",
  connectionStates: "express_connection_states",
  uptimeInfo: "express_uptime",
  statsReset: "express_stats_reset",
  currentDatabase: "express_current_database",
} as const;

/**
 * Transform a row from metrics query output to JSON report format.
 * Metrics use `tag_` prefix for dimensions; we strip it for JSON reports.
 * Also removes Prometheus-specific fields like epoch_ns, num.
 */
export function transformMetricRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(row)) {
    // Skip Prometheus-specific fields
    if (key === "epoch_ns" || key === "num" || key === "tag_datname") {
      continue;
    }
    
    // Strip tag_ prefix
    const newKey = key.startsWith("tag_") ? key.slice(4) : key;
    result[newKey] = value;
  }
  
  return result;
}

// Legacy export for backward compatibility (no longer loads from file)
export function loadMetricsYml(): { metrics: Record<string, unknown> } {
  return { metrics: EMBEDDED_SQL };
}
