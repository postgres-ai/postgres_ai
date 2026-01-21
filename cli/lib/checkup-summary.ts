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
    case 'H001': return summarizeH001(nodeData);
    case 'H002': return summarizeH002(nodeData);
    case 'H004': return summarizeH004(nodeData);
    case 'F004': return summarizeF004(nodeData);
    case 'F005': return summarizeF005(nodeData);
    case 'A002': return summarizeA002(nodeData);
    case 'A013': return summarizeA013(nodeData);
    case 'A003':
    case 'D001':
    case 'G003':
    case 'F001':
      return { status: 'info', message: 'Settings analyzed' };
    default:
      return { status: 'info', message: 'Check completed' };
  }
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

function summarizeF004(nodeData: any): CheckSummary {
  const data = nodeData?.data || {};
  let totalCount = 0;
  let totalBloatSize = 0;
  let maxBloatPct = 0;

  // Aggregate across all databases
  for (const dbData of Object.values(data)) {
    const dbEntry = dbData as any;
    totalCount += dbEntry.total_count || 0;
    totalBloatSize += dbEntry.total_bloat_size_bytes || 0;

    // Find max bloat percentage across all tables
    const tables = dbEntry.bloated_tables || [];
    for (const table of tables) {
      maxBloatPct = Math.max(maxBloatPct, table.bloat_pct || 0);
    }
  }

  if (totalCount === 0) {
    return { status: 'ok', message: 'No significant table bloat' };
  }

  return {
    status: 'warning',
    message: `${totalCount} table${totalCount > 1 ? 's' : ''} with bloat (${formatBytes(totalBloatSize)}, max ${maxBloatPct.toFixed(0)}%)`
  };
}

function summarizeF005(nodeData: any): CheckSummary {
  const data = nodeData?.data || {};
  let totalCount = 0;
  let totalBloatSize = 0;
  let maxBloatPct = 0;

  // Aggregate across all databases
  for (const dbData of Object.values(data)) {
    const dbEntry = dbData as any;
    totalCount += dbEntry.total_count || 0;
    totalBloatSize += dbEntry.total_bloat_size_bytes || 0;

    // Find max bloat percentage across all indexes
    const indexes = dbEntry.bloated_indexes || [];
    for (const index of indexes) {
      maxBloatPct = Math.max(maxBloatPct, index.bloat_pct || 0);
    }
  }

  if (totalCount === 0) {
    return { status: 'ok', message: 'No significant index bloat' };
  }

  return {
    status: 'warning',
    message: `${totalCount} index${totalCount > 1 ? 'es' : ''} with bloat (${formatBytes(totalBloatSize)}, max ${maxBloatPct.toFixed(0)}%)`
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
