/**
 * Load SQL queries from metrics.yml
 * 
 * IMPORTANT: This module loads SQL queries directly from config/pgwatch-prometheus/metrics.yml
 * to avoid code duplication. The metrics.yml is the single source of truth for metric extraction logic.
 * 
 * DO NOT copy-paste SQL queries into TypeScript code. Always load them from metrics.yml.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";

// Get the path to metrics.yml relative to this file
function getMetricsYmlPath(): string {
  // When running from source: cli/lib/metrics-loader.ts -> config/pgwatch-prometheus/metrics.yml
  // When running from dist: cli/dist/lib/metrics-loader.js -> config/pgwatch-prometheus/metrics.yml
  const currentDir = typeof __dirname !== "undefined" 
    ? __dirname 
    : dirname(fileURLToPath(import.meta.url));
  
  // Try multiple possible locations
  const possiblePaths = [
    resolve(currentDir, "../../config/pgwatch-prometheus/metrics.yml"),      // from cli/lib
    resolve(currentDir, "../../../config/pgwatch-prometheus/metrics.yml"),   // from cli/dist/lib
    resolve(currentDir, "../../../../config/pgwatch-prometheus/metrics.yml"), // deeper nesting
  ];
  
  for (const path of possiblePaths) {
    try {
      readFileSync(path);
      return path;
    } catch {
      // Try next path
    }
  }
  
  throw new Error(`Cannot find metrics.yml. Tried: ${possiblePaths.join(", ")}`);
}

interface MetricDefinition {
  description?: string;
  sqls?: {
    [pgVersion: string]: string;
  };
  gauges?: string[];
  statement_timeout_seconds?: number;
}

interface MetricsYmlRoot {
  metrics: {
    [metricName: string]: MetricDefinition;
  };
}

let cachedMetrics: MetricsYmlRoot | null = null;

/**
 * Load and parse metrics.yml (cached after first load)
 */
export function loadMetricsYml(): MetricsYmlRoot {
  if (cachedMetrics) {
    return cachedMetrics;
  }
  
  const metricsPath = getMetricsYmlPath();
  const content = readFileSync(metricsPath, "utf8");
  cachedMetrics = yaml.load(content) as MetricsYmlRoot;
  return cachedMetrics;
}

/**
 * Get SQL query for a specific metric and PostgreSQL version.
 * Falls back to lower versions if exact version not found.
 * 
 * @param metricName - Name of the metric in metrics.yml (e.g., "pg_invalid_indexes")
 * @param pgMajorVersion - PostgreSQL major version (e.g., 16)
 * @returns SQL query string
 */
export function getMetricSql(metricName: string, pgMajorVersion: number = 16): string {
  const root = loadMetricsYml();
  const metric = root.metrics[metricName];
  
  if (!metric) {
    throw new Error(`Metric "${metricName}" not found in metrics.yml`);
  }
  
  if (!metric.sqls) {
    throw new Error(`Metric "${metricName}" has no SQL queries defined`);
  }
  
  // Try exact version first, then fall back to lower versions
  const versions = Object.keys(metric.sqls)
    .map(Number)
    .filter(v => !isNaN(v))
    .sort((a, b) => b - a); // Sort descending
  
  for (const version of versions) {
    if (version <= pgMajorVersion) {
      return metric.sqls[version.toString()];
    }
  }
  
  // If no matching version, use the lowest available
  const lowestVersion = versions[versions.length - 1];
  if (lowestVersion !== undefined) {
    return metric.sqls[lowestVersion.toString()];
  }
  
  throw new Error(`No SQL query found for metric "${metricName}"`);
}

/**
 * Metric names in metrics.yml that correspond to health checks
 */
export const METRIC_NAMES = {
  H001: "pg_invalid_indexes",
  H002: "unused_indexes", 
  H004: "redundant_indexes",
} as const;

/**
 * Transform a row from metrics.yml query output to JSON report format.
 * Metrics.yml uses `tag_` prefix for dimensions; we strip it for JSON reports.
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

