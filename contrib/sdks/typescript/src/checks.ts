/**
 * Available health checks and their metadata
 */

import type { CheckInfo } from './types';

export const AVAILABLE_CHECKS: Record<string, CheckInfo> = {
  A002: {
    title: 'Postgres major version',
    method: 'checkA002Version',
    description: 'Get PostgreSQL major version information',
  },
  H001: {
    title: 'Invalid indexes',
    method: 'checkH001InvalidIndexes',
    description: 'Find invalid indexes (indisvalid = false)',
  },
  H002: {
    title: 'Unused indexes',
    method: 'checkH002UnusedIndexes',
    description: 'Find indexes that have never been scanned',
  },
  H004: {
    title: 'Redundant indexes',
    method: 'checkH004RedundantIndexes',
    description: 'Find indexes covered by other indexes',
  },
  F004: {
    title: 'Autovacuum: heap bloat (estimated)',
    method: 'checkF004TableBloat',
    description: 'Estimate table bloat from dead tuples',
  },
};
