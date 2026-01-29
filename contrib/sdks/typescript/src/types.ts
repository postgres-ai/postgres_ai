/**
 * Type definitions for PostgresAI Express Checkup
 */

/**
 * PostgreSQL version information
 */
export interface PostgresVersion {
  version: string;
  server_version_num: number;
  major: number;
  minor: number;
}

/**
 * Executor function type - abstracts the database client
 * Takes a SQL string and returns an array of row objects
 */
export type SqlExecutor = (sql: string) => Promise<Record<string, unknown>[]>;

/**
 * Result of a single health check
 */
export interface CheckResult {
  checkId: string;
  checkTitle: string;
  timestamptz: string;
  generation_mode: 'express';
  data: Record<string, unknown>;
  postgres_version?: PostgresVersion;
  error?: string;
}

/**
 * Full report structure matching JSON schema
 */
export interface Report {
  checkId: string;
  checkTitle: string;
  timestamptz: string;
  generation_mode: 'express' | null;
  version?: string | null;
  build_ts?: string | null;
  nodes: {
    primary: string;
    standbys: string[];
  };
  results: Record<string, NodeResult>;
}

export interface NodeResult {
  data: Record<string, unknown>;
  postgres_version?: {
    version: string;
    server_version_num: string;
    server_major_ver: string;
    server_minor_ver: string;
  };
  error?: string;
}

/**
 * Unused index entry (H002)
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
 * Invalid index entry (H001)
 */
export interface InvalidIndex {
  schema_name: string;
  table_name: string;
  index_name: string;
  relation_name: string;
  index_size_bytes: number;
  index_size_pretty: string;
  index_definition: string;
  supports_fk: boolean;
  is_pk: boolean;
  is_unique: boolean;
  constraint_name: string | null;
  table_row_estimate: number;
  has_valid_duplicate: boolean;
  valid_duplicate_name: string | null;
  valid_duplicate_definition: string | null;
}

/**
 * Redundant index entry (H004)
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
  redundant_to: RedundantToIndex[];
}

export interface RedundantToIndex {
  index_name: string;
  index_definition: string;
  index_size_bytes: number;
  index_size_pretty: string;
}

/**
 * Table bloat entry (F004)
 */
export interface BloatedTable {
  schema_name: string;
  table_name: string;
  real_size: number;
  real_size_pretty: string;
  bloat_pct: number;
  bloat_size: number;
  bloat_size_pretty: string;
  dead_tuples: number;
  live_tuples: number;
  last_vacuum: string | null;
  fillfactor: number;
}

/**
 * Stats reset info (H002)
 */
export interface StatsReset {
  stats_reset_epoch: number | null;
  stats_reset_time: string | null;
  days_since_reset: number | null;
  postmaster_startup_epoch: number | null;
  postmaster_startup_time: string | null;
}

/**
 * Progress callback for runAll()
 */
export type ProgressCallback = (info: {
  checkId: string;
  checkTitle: string;
  index: number;
  total: number;
}) => void;

/**
 * Check metadata
 */
export interface CheckInfo {
  title: string;
  method: string;
  description: string;
}
