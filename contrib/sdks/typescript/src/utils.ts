/**
 * Utility functions for PostgresAI Express Checkup
 */

/**
 * Format bytes to human-readable string using binary units (1024-based).
 * Uses IEC standard: KiB, MiB, GiB, etc.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 0) return `-${formatBytes(-bytes)}`;
  if (!Number.isFinite(bytes)) return `${bytes} B`;

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Convert various boolean representations to boolean.
 * PostgreSQL returns booleans as true/false, 1/0, 't'/'f', or 'true'/'false'.
 */
export function toBool(val: unknown): boolean {
  return val === true || val === 1 || val === 't' || val === 'true';
}

/**
 * Parse PostgreSQL version number into major and minor components
 */
export function parseVersionNum(versionNum: number): { major: number; minor: number } {
  return {
    major: Math.floor(versionNum / 10000),
    minor: versionNum % 10000,
  };
}
