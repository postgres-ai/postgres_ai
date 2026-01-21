/**
 * Generate human-readable summaries from checkup report JSON.
 * Used for default CLI output without requiring API calls.
 */

export interface CheckSummary {
  status: 'ok' | 'warning' | 'info';
  message: string;
}

/**
 * Extract summary information from a checkup report.
 * Parses the JSON structure to extract key metrics for CLI display.
 */
export function generateCheckSummary(checkId: string, report: any): CheckSummary {
  const nodeIds = Object.keys(report.results || {});
  if (nodeIds.length === 0) {
    return { status: 'info', message: 'No data' };
  }

  // Take first node for summary (most deployments use single node)
  const nodeData = report.results[nodeIds[0]];

  switch (checkId) {
    // Index health checks
    case 'H001': return summarizeH001(nodeData);
    case 'H002': return summarizeH002(nodeData);
    case 'H004': return summarizeH004(nodeData);
    // Version checks
    case 'A002': return summarizeA002(nodeData);
    case 'A013': return summarizeA013(nodeData);
    // Settings checks (informational)
    case 'A003': return { status: 'info', message: 'Postgres settings analyzed' };
    case 'A004': return summarizeA004(nodeData);
    case 'A007': return summarizeA007(nodeData);
    case 'D001': return { status: 'info', message: 'Logging settings reviewed' };
    case 'D004': return { status: 'info', message: 'pg_stat_statements settings reviewed' };
    case 'F001': return { status: 'info', message: 'Autovacuum settings reviewed' };
    case 'G001': return { status: 'info', message: 'Memory settings reviewed' };
    case 'G003': return { status: 'info', message: 'Timeout settings reviewed' };
    default:
      return { status: 'info', message: 'Check completed' };
  }
}

function summarizeA004(nodeData: any): CheckSummary {
  const data = nodeData?.data;
  if (!data) {
    return { status: 'info', message: 'Cluster information collected' };
  }

  const dbCount = Object.keys(data.database_sizes || {}).length;
  if (dbCount > 0) {
    return { status: 'info', message: `${dbCount} database${dbCount > 1 ? 's' : ''} analyzed` };
  }

  return { status: 'info', message: 'Cluster information collected' };
}

function summarizeA007(nodeData: any): CheckSummary {
  const data = nodeData?.data || {};
  const alteredCount = Object.keys(data).length;

  if (alteredCount === 0) {
    return { status: 'ok', message: 'No altered settings' };
  }

  return {
    status: 'info',
    message: `${alteredCount} setting${alteredCount > 1 ? 's' : ''} altered from defaults`
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function summarizeH001(nodeData: any): CheckSummary {
  const data = nodeData?.data || {};
  let totalCount = 0;
  let totalSize = 0;

  // Aggregate across all databases
  for (const dbData of Object.values(data)) {
    const dbEntry = dbData as any;
    totalCount += dbEntry.total_count || 0;
    totalSize += dbEntry.total_size_bytes || 0;
  }

  if (totalCount === 0) {
    return { status: 'ok', message: 'No invalid indexes' };
  }

  return {
    status: 'warning',
    message: `Found ${totalCount} invalid index${totalCount > 1 ? 'es' : ''} (${formatBytes(totalSize)})`
  };
}

function summarizeH002(nodeData: any): CheckSummary {
  const data = nodeData?.data || {};
  let totalCount = 0;
  let totalSize = 0;

  // Aggregate across all databases
  for (const dbData of Object.values(data)) {
    const dbEntry = dbData as any;
    totalCount += dbEntry.total_count || 0;
    totalSize += dbEntry.total_size_bytes || 0;
  }

  if (totalCount === 0) {
    return { status: 'ok', message: 'All indexes utilized' };
  }

  return {
    status: 'warning',
    message: `Found ${totalCount} unused index${totalCount > 1 ? 'es' : ''} (${formatBytes(totalSize)})`
  };
}

function summarizeH004(nodeData: any): CheckSummary {
  const data = nodeData?.data || {};
  let totalCount = 0;
  let totalSize = 0;

  // Aggregate across all databases
  for (const dbData of Object.values(data)) {
    const dbEntry = dbData as any;
    totalCount += dbEntry.total_count || 0;
    totalSize += dbEntry.total_size_bytes || 0;
  }

  if (totalCount === 0) {
    return { status: 'ok', message: 'No redundant indexes' };
  }

  return {
    status: 'warning',
    message: `Found ${totalCount} redundant index${totalCount > 1 ? 'es' : ''} (${formatBytes(totalSize)})`
  };
}

function summarizeA002(nodeData: any): CheckSummary {
  const ver = nodeData?.postgres_version;
  if (!ver) {
    return { status: 'info', message: 'Version checked' };
  }

  const major = parseInt(ver.server_major_ver, 10);

  // PostgreSQL 17 is current (as of early 2025)
  if (major >= 17) {
    return { status: 'ok', message: `PostgreSQL ${major}` };
  }

  if (major >= 15) {
    return { status: 'info', message: `PostgreSQL ${major}` };
  }

  return {
    status: 'warning',
    message: `PostgreSQL ${major} (consider upgrading)`
  };
}

function summarizeA013(nodeData: any): CheckSummary {
  const ver = nodeData?.postgres_version;
  if (!ver) {
    return { status: 'info', message: 'Minor version checked' };
  }

  const current = ver.version || '';

  // In real implementation, would compare with latest minor
  // For now, just show the version
  return {
    status: 'info',
    message: `Version ${current}`
  };
}
