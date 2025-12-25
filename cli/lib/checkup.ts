/**
 * Express checkup module - generates JSON reports directly from PostgreSQL
 * without going through Prometheus.
 *
 * This module reuses the same SQL queries from metrics.yml but runs them
 * directly against the target database.
 */

import { Client } from "pg";

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

  // Version info - extracts server_version and server_version_num
  version: `
    SELECT
      name,
      setting
    FROM pg_settings
    WHERE name IN ('server_version', 'server_version_num')
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
 * Create base report structure
 */
export function createBaseReport(
  checkId: string,
  checkTitle: string,
  nodeName: string
): Report {
  return {
    version: null,
    build_ts: null,
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
  A013: generateA013,
};

/**
 * Check IDs and titles
 */
export const CHECK_INFO: Record<string, string> = {
  A002: "Postgres major version",
  A003: "Postgres settings",
  A013: "Postgres minor version",
};

/**
 * Generate all available reports
 */
export async function generateAllReports(
  client: Client,
  nodeName: string = "node-01"
): Promise<Record<string, Report>> {
  const reports: Record<string, Report> = {};

  for (const [checkId, generator] of Object.entries(REPORT_GENERATORS)) {
    reports[checkId] = await generator(client, nodeName);
  }

  return reports;
}
