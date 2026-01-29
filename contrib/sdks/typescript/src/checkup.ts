/**
 * Core checkup functionality for PostgreSQL health checks
 */

import type {
  SqlExecutor,
  PostgresVersion,
  Report,
  ProgressCallback,
  UnusedIndex,
  InvalidIndex,
  RedundantIndex,
  BloatedTable,
  StatsReset,
} from './types';
import { AVAILABLE_CHECKS } from './checks';
import { formatBytes, toBool, parseVersionNum } from './utils';

/**
 * PostgreSQL health check runner.
 *
 * Designed to work with any PostgreSQL client by accepting a SQL executor function.
 *
 * @example
 * // With 'pg' package
 * import { Client } from 'pg';
 * const client = new Client('postgresql://...');
 * await client.connect();
 * const checkup = new Checkup(async (sql) => {
 *   const result = await client.query(sql);
 *   return result.rows;
 * });
 *
 * @example
 * // With 'postgres' package (porsager/postgres)
 * import postgres from 'postgres';
 * const sql = postgres('postgresql://...');
 * const checkup = new Checkup(async (query) => sql.unsafe(query));
 *
 * @example
 * // With Drizzle ORM
 * import { drizzle } from 'drizzle-orm/node-postgres';
 * const db = drizzle(pool);
 * const checkup = new Checkup(async (sql) => db.execute(sql));
 */
export class Checkup {
  private executor: SqlExecutor;
  private nodeName: string;
  private pgVersion: PostgresVersion | null = null;

  constructor(executor: SqlExecutor, nodeName: string = 'node-01') {
    this.executor = executor;
    this.nodeName = nodeName;
  }

  /**
   * Execute SQL and return results
   */
  private async execute<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    return (await this.executor(sql)) as T[];
  }

  /**
   * Get PostgreSQL version information
   */
  async getPostgresVersion(): Promise<PostgresVersion> {
    if (this.pgVersion) return this.pgVersion;

    const rows = await this.execute<{ name: string; setting: string }>(`
      SELECT name, setting
      FROM pg_settings
      WHERE name IN ('server_version', 'server_version_num')
    `);

    let version = '';
    let versionNum = 0;

    for (const row of rows) {
      if (row.name === 'server_version') {
        version = row.setting;
      } else if (row.name === 'server_version_num') {
        versionNum = parseInt(row.setting, 10);
      }
    }

    const { major, minor } = parseVersionNum(versionNum);

    this.pgVersion = {
      version,
      server_version_num: versionNum,
      major,
      minor,
    };

    return this.pgVersion;
  }

  /**
   * Get current database name and size
   */
  async getCurrentDatabase(): Promise<{ datname: string; size_bytes: number }> {
    const rows = await this.execute<{ datname: string; size_bytes: string }>(`
      SELECT
        current_database() as datname,
        pg_database_size(current_database()) as size_bytes
    `);
    const row = rows[0];
    return {
      datname: row?.datname || 'postgres',
      size_bytes: parseInt(row?.size_bytes || '0', 10),
    };
  }

  /**
   * Create a report structure
   */
  private createReport(
    checkId: string,
    checkTitle: string,
    data: Record<string, unknown>,
    error?: string
  ): Report {
    const result: Report = {
      checkId,
      checkTitle,
      timestamptz: new Date().toISOString(),
      generation_mode: 'express',
      nodes: { primary: this.nodeName, standbys: [] },
      results: {
        [this.nodeName]: {
          data,
          ...(this.pgVersion && {
            postgres_version: {
              version: this.pgVersion.version,
              server_version_num: String(this.pgVersion.server_version_num),
              server_major_ver: String(this.pgVersion.major),
              server_minor_ver: String(this.pgVersion.minor),
            },
          }),
          ...(error && { error }),
        },
      },
    };
    return result;
  }

  // ===========================================================================
  // Individual Check Methods
  // ===========================================================================

  /**
   * H002: Find unused indexes
   */
  async checkH002UnusedIndexes(): Promise<Report> {
    await this.getPostgresVersion();
    const dbInfo = await this.getCurrentDatabase();

    const sql = `
      WITH fk_indexes AS (
        SELECT
          n.nspname AS schema_name,
          ci.relname AS index_name,
          cr.relname AS table_name,
          (confrelid::regclass)::text AS fk_table_ref,
          array_to_string(indclass, ', ') AS opclasses
        FROM pg_index i
        JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relkind = 'i'
        JOIN pg_class cr ON cr.oid = i.indrelid AND cr.relkind = 'r'
        JOIN pg_namespace n ON n.oid = ci.relnamespace
        JOIN pg_constraint cn ON cn.conrelid = cr.oid
        LEFT JOIN pg_stat_all_indexes AS si ON si.indexrelid = i.indexrelid
        WHERE contype = 'f'
          AND i.indisunique IS false
          AND conkey IS NOT NULL
          AND ci.relpages > 5
          AND si.idx_scan < 10
      ),
      table_scans AS (
        SELECT
          relid,
          tables.idx_scan + tables.seq_scan AS all_scans,
          (tables.n_tup_ins + tables.n_tup_upd + tables.n_tup_del) AS writes,
          pg_relation_size(relid) AS table_size
        FROM pg_stat_all_tables AS tables
        JOIN pg_class c ON c.oid = relid
        WHERE c.relpages > 5
      ),
      indexes AS (
        SELECT
          i.indrelid,
          i.indexrelid,
          n.nspname AS schema_name,
          cr.relname AS table_name,
          ci.relname AS index_name,
          si.idx_scan,
          pg_relation_size(i.indexrelid) AS index_bytes,
          ci.relpages,
          (CASE WHEN a.amname = 'btree' THEN true ELSE false END) AS idx_is_btree,
          array_to_string(i.indclass, ', ') AS opclasses
        FROM pg_index i
        JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relkind = 'i'
        JOIN pg_class cr ON cr.oid = i.indrelid AND cr.relkind = 'r'
        JOIN pg_namespace n ON n.oid = ci.relnamespace
        JOIN pg_am a ON ci.relam = a.oid
        LEFT JOIN pg_stat_all_indexes AS si ON si.indexrelid = i.indexrelid
        WHERE i.indisunique = false
          AND i.indisvalid = true
          AND ci.relpages > 5
      ),
      index_ratios AS (
        SELECT
          i.indexrelid AS index_id,
          i.schema_name,
          i.table_name,
          i.index_name,
          idx_scan,
          all_scans,
          ROUND((CASE WHEN all_scans = 0 THEN 0.0::numeric
              ELSE idx_scan::numeric/all_scans * 100 END), 2) AS index_scan_pct,
          writes,
          ROUND((CASE WHEN writes = 0 THEN idx_scan::numeric
              ELSE idx_scan::numeric/writes END), 2) AS scans_per_write,
          index_bytes AS index_size_bytes,
          table_size AS table_size_bytes,
          i.relpages,
          idx_is_btree,
          i.opclasses,
          (
            SELECT count(1)
            FROM fk_indexes fi
            WHERE fi.fk_table_ref = i.table_name
              AND fi.schema_name = i.schema_name
              AND fi.opclasses LIKE (i.opclasses || '%')
          ) > 0 AS supports_fk
        FROM indexes i
        JOIN table_scans ts ON ts.relid = i.indrelid
      )
      SELECT
        'Never Used Indexes' AS reason,
        schema_name,
        table_name,
        index_name,
        pg_get_indexdef(index_id) AS index_definition,
        idx_scan,
        index_size_bytes,
        idx_is_btree,
        supports_fk
      FROM index_ratios
      WHERE idx_scan = 0
      ORDER BY index_size_bytes DESC
    `;

    const rows = await this.execute(sql);

    // Get stats reset info
    const statsResetRows = await this.execute<{
      stats_reset_epoch: string;
      stats_reset_time: string;
      days_since_reset: string;
    }>(`
      SELECT
        EXTRACT(EPOCH FROM stats_reset) AS stats_reset_epoch,
        stats_reset::text AS stats_reset_time,
        EXTRACT(EPOCH FROM (now() - stats_reset)) / 86400 AS days_since_reset
      FROM pg_stat_database
      WHERE datname = current_database()
    `);
    const statsResetRow = statsResetRows[0] || {};

    const unusedIndexes: UnusedIndex[] = [];
    let totalSize = 0;

    for (const row of rows) {
      const sizeBytes = parseInt(String(row.index_size_bytes || 0), 10);
      totalSize += sizeBytes;

      unusedIndexes.push({
        schema_name: String(row.schema_name || ''),
        table_name: String(row.table_name || ''),
        index_name: String(row.index_name || ''),
        index_definition: String(row.index_definition || ''),
        reason: String(row.reason || 'Never Used Indexes'),
        idx_scan: parseInt(String(row.idx_scan || 0), 10),
        index_size_bytes: sizeBytes,
        idx_is_btree: toBool(row.idx_is_btree),
        supports_fk: toBool(row.supports_fk),
        index_size_pretty: formatBytes(sizeBytes),
      });
    }

    const statsReset: StatsReset = {
      stats_reset_epoch: statsResetRow.stats_reset_epoch
        ? parseFloat(statsResetRow.stats_reset_epoch)
        : null,
      stats_reset_time: statsResetRow.stats_reset_time || null,
      days_since_reset: statsResetRow.days_since_reset
        ? Math.floor(parseFloat(statsResetRow.days_since_reset))
        : null,
      postmaster_startup_epoch: null,
      postmaster_startup_time: null,
    };

    const data = {
      [dbInfo.datname]: {
        unused_indexes: unusedIndexes,
        total_count: unusedIndexes.length,
        total_size_bytes: totalSize,
        total_size_pretty: formatBytes(totalSize),
        database_size_bytes: dbInfo.size_bytes,
        database_size_pretty: formatBytes(dbInfo.size_bytes),
        stats_reset: statsReset,
      },
    };

    return this.createReport('H002', 'Unused indexes', data);
  }

  /**
   * H001: Find invalid indexes
   */
  async checkH001InvalidIndexes(): Promise<Report> {
    await this.getPostgresVersion();
    const dbInfo = await this.getCurrentDatabase();

    const sql = `
      WITH invalid AS (
        SELECT
          n.nspname AS schema_name,
          ct.relname AS table_name,
          ci.relname AS index_name,
          n.nspname || '.' || ci.relname AS relation_name,
          pg_relation_size(i.indexrelid) AS index_size_bytes,
          pg_get_indexdef(i.indexrelid) AS index_definition,
          i.indisprimary AS is_pk,
          i.indisunique AS is_unique,
          con.conname AS constraint_name,
          ct.reltuples::bigint AS table_row_estimate,
          EXISTS (
            SELECT 1 FROM pg_index i2
            JOIN pg_class ci2 ON ci2.oid = i2.indexrelid
            WHERE i2.indrelid = i.indrelid
              AND i2.indisvalid = true
              AND pg_get_indexdef(i2.indexrelid) = pg_get_indexdef(i.indexrelid)
          ) AS has_valid_duplicate
        FROM pg_index i
        JOIN pg_class ci ON ci.oid = i.indexrelid
        JOIN pg_class ct ON ct.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = ci.relnamespace
        LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
        WHERE i.indisvalid = false
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      )
      SELECT * FROM invalid ORDER BY index_size_bytes DESC
    `;

    const rows = await this.execute(sql);

    const invalidIndexes: InvalidIndex[] = [];
    let totalSize = 0;

    for (const row of rows) {
      const sizeBytes = parseInt(String(row.index_size_bytes || 0), 10);
      totalSize += sizeBytes;

      invalidIndexes.push({
        schema_name: String(row.schema_name || ''),
        table_name: String(row.table_name || ''),
        index_name: String(row.index_name || ''),
        relation_name: String(row.relation_name || ''),
        index_size_bytes: sizeBytes,
        index_size_pretty: formatBytes(sizeBytes),
        index_definition: String(row.index_definition || ''),
        supports_fk: false,
        is_pk: toBool(row.is_pk),
        is_unique: toBool(row.is_unique),
        constraint_name: row.constraint_name ? String(row.constraint_name) : null,
        table_row_estimate: parseInt(String(row.table_row_estimate || 0), 10),
        has_valid_duplicate: toBool(row.has_valid_duplicate),
        valid_duplicate_name: null,
        valid_duplicate_definition: null,
      });
    }

    const data = {
      [dbInfo.datname]: {
        invalid_indexes: invalidIndexes,
        total_count: invalidIndexes.length,
        total_size_bytes: totalSize,
        total_size_pretty: formatBytes(totalSize),
        database_size_bytes: dbInfo.size_bytes,
        database_size_pretty: formatBytes(dbInfo.size_bytes),
      },
    };

    return this.createReport('H001', 'Invalid indexes', data);
  }

  /**
   * H004: Find redundant indexes
   */
  async checkH004RedundantIndexes(): Promise<Report> {
    await this.getPostgresVersion();
    const dbInfo = await this.getCurrentDatabase();

    const sql = `
      WITH index_data AS (
        SELECT
          n.nspname AS schema_name,
          ct.relname AS table_name,
          ci.relname AS index_name,
          n.nspname || '.' || ci.relname AS relation_name,
          am.amname AS access_method,
          pg_get_indexdef(i.indexrelid) AS index_definition,
          pg_relation_size(i.indexrelid) AS index_size_bytes,
          pg_relation_size(i.indrelid) AS table_size_bytes,
          COALESCE(s.idx_scan, 0) AS index_usage,
          i.indkey::text AS indkey_text,
          i.indrelid,
          i.indexrelid
        FROM pg_index i
        JOIN pg_class ci ON ci.oid = i.indexrelid
        JOIN pg_class ct ON ct.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = ci.relnamespace
        JOIN pg_am am ON am.oid = ci.relam
        LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
        WHERE i.indisvalid = true
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ),
      redundant AS (
        SELECT
          d1.*,
          d2.index_name AS redundant_to_name,
          d2.index_definition AS redundant_to_definition,
          d2.index_size_bytes AS redundant_to_size_bytes
        FROM index_data d1
        JOIN index_data d2 ON d1.indrelid = d2.indrelid
          AND d1.indexrelid != d2.indexrelid
          AND d1.indkey_text LIKE d2.indkey_text || '%'
          AND d1.indkey_text != d2.indkey_text
        WHERE d1.access_method = d2.access_method
      )
      SELECT DISTINCT ON (schema_name, table_name, index_name)
        schema_name,
        table_name,
        index_name,
        relation_name,
        access_method,
        'Redundant to: ' || redundant_to_name AS reason,
        index_size_bytes,
        table_size_bytes,
        index_usage,
        false AS supports_fk,
        index_definition,
        json_agg(json_build_object(
          'index_name', redundant_to_name,
          'index_definition', redundant_to_definition,
          'index_size_bytes', redundant_to_size_bytes
        )) AS redundant_to_json
      FROM redundant
      GROUP BY schema_name, table_name, index_name, relation_name,
               access_method, index_size_bytes, table_size_bytes,
               index_usage, index_definition, redundant_to_name
      ORDER BY schema_name, table_name, index_name, index_size_bytes DESC
    `;

    const rows = await this.execute(sql);

    const redundantIndexes: RedundantIndex[] = [];
    let totalSize = 0;

    for (const row of rows) {
      const sizeBytes = parseInt(String(row.index_size_bytes || 0), 10);
      const tableSize = parseInt(String(row.table_size_bytes || 0), 10);
      totalSize += sizeBytes;

      // Parse redundant_to JSON
      let redundantTo: RedundantIndex['redundant_to'] = [];
      try {
        let rtData = row.redundant_to_json;
        if (typeof rtData === 'string') {
          rtData = JSON.parse(rtData);
        }
        if (Array.isArray(rtData)) {
          redundantTo = rtData.map((item: Record<string, unknown>) => {
            const rtSize = parseInt(String(item.index_size_bytes || 0), 10);
            return {
              index_name: String(item.index_name || ''),
              index_definition: String(item.index_definition || ''),
              index_size_bytes: rtSize,
              index_size_pretty: formatBytes(rtSize),
            };
          });
        }
      } catch {
        // Ignore parse errors
      }

      redundantIndexes.push({
        schema_name: String(row.schema_name || ''),
        table_name: String(row.table_name || ''),
        index_name: String(row.index_name || ''),
        relation_name: String(row.relation_name || ''),
        access_method: String(row.access_method || 'btree'),
        reason: String(row.reason || ''),
        index_size_bytes: sizeBytes,
        table_size_bytes: tableSize,
        index_usage: parseInt(String(row.index_usage || 0), 10),
        supports_fk: toBool(row.supports_fk),
        index_definition: String(row.index_definition || ''),
        index_size_pretty: formatBytes(sizeBytes),
        table_size_pretty: formatBytes(tableSize),
        redundant_to: redundantTo,
      });
    }

    const data = {
      [dbInfo.datname]: {
        redundant_indexes: redundantIndexes,
        total_count: redundantIndexes.length,
        total_size_bytes: totalSize,
        total_size_pretty: formatBytes(totalSize),
        database_size_bytes: dbInfo.size_bytes,
        database_size_pretty: formatBytes(dbInfo.size_bytes),
      },
    };

    return this.createReport('H004', 'Redundant indexes', data);
  }

  /**
   * A002: Get PostgreSQL version
   */
  async checkA002Version(): Promise<Report> {
    const pgVer = await this.getPostgresVersion();

    const data = {
      version: {
        version: pgVer.version,
        server_version_num: String(pgVer.server_version_num),
        server_major_ver: String(pgVer.major),
        server_minor_ver: String(pgVer.minor),
      },
    };

    return this.createReport('A002', 'Postgres major version', data);
  }

  /**
   * F004: Estimate table bloat
   */
  async checkF004TableBloat(): Promise<Report> {
    await this.getPostgresVersion();
    const dbInfo = await this.getCurrentDatabase();

    const sql = `
      SELECT
        schemaname AS schema_name,
        relname AS table_name,
        pg_relation_size(relid) AS real_size,
        COALESCE(n_dead_tup, 0) AS dead_tuples,
        COALESCE(n_live_tup, 0) AS live_tuples,
        CASE WHEN n_live_tup > 0
          THEN ROUND(100.0 * n_dead_tup / n_live_tup, 2)
          ELSE 0
        END AS bloat_pct,
        last_vacuum,
        last_autovacuum
      FROM pg_stat_user_tables
      WHERE pg_relation_size(relid) > 1024 * 1024
      ORDER BY n_dead_tup DESC
      LIMIT 100
    `;

    const rows = await this.execute(sql);

    const bloatedTables: BloatedTable[] = [];
    let totalBloat = 0;

    for (const row of rows) {
      const realSize = parseInt(String(row.real_size || 0), 10);
      const bloatPct = parseFloat(String(row.bloat_pct || 0));
      const estimatedBloat = Math.floor((realSize * bloatPct) / 100);
      totalBloat += estimatedBloat;

      const lastVacuum = row.last_vacuum || row.last_autovacuum;

      bloatedTables.push({
        schema_name: String(row.schema_name || ''),
        table_name: String(row.table_name || ''),
        real_size: realSize,
        real_size_pretty: formatBytes(realSize),
        bloat_pct: bloatPct,
        bloat_size: estimatedBloat,
        bloat_size_pretty: formatBytes(estimatedBloat),
        dead_tuples: parseInt(String(row.dead_tuples || 0), 10),
        live_tuples: parseInt(String(row.live_tuples || 0), 10),
        last_vacuum: lastVacuum ? String(lastVacuum) : null,
        fillfactor: 100,
      });
    }

    const data = {
      [dbInfo.datname]: {
        bloated_tables: bloatedTables,
        total_count: bloatedTables.length,
        total_bloat_size_bytes: totalBloat,
        total_bloat_size_pretty: formatBytes(totalBloat),
        database_size_bytes: dbInfo.size_bytes,
        database_size_pretty: formatBytes(dbInfo.size_bytes),
      },
    };

    return this.createReport('F004', 'Autovacuum: heap bloat (estimated)', data);
  }

  // ===========================================================================
  // Run Checks
  // ===========================================================================

  /**
   * Run all available health checks
   */
  async runAll(onProgress?: ProgressCallback): Promise<Record<string, Report>> {
    const results: Record<string, Report> = {};
    const entries = Object.entries(AVAILABLE_CHECKS);
    const total = entries.length;

    for (let i = 0; i < entries.length; i++) {
      const [checkId, checkInfo] = entries[i];

      onProgress?.({
        checkId,
        checkTitle: checkInfo.title,
        index: i + 1,
        total,
      });

      const method = (this as Record<string, unknown>)[checkInfo.method];
      if (typeof method === 'function') {
        try {
          results[checkId] = await (method as () => Promise<Report>).call(this);
        } catch (err) {
          results[checkId] = this.createReport(
            checkId,
            checkInfo.title,
            {},
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }

    return results;
  }

  /**
   * Run a specific check by ID
   */
  async runCheck(checkId: string): Promise<Report> {
    const checkInfo = AVAILABLE_CHECKS[checkId];
    if (!checkInfo) {
      throw new Error(`Unknown check ID: ${checkId}`);
    }

    const method = (this as Record<string, unknown>)[checkInfo.method];
    if (typeof method !== 'function') {
      throw new Error(`Check method not implemented: ${checkInfo.method}`);
    }

    return (method as () => Promise<Report>).call(this);
  }
}
