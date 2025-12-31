# Fix Index Issues

Analyze and remediate index-related issues identified by health checks.

## Arguments
- `$ARGUMENTS`: Optional - specific index name or "all" for comprehensive analysis

## Instructions

### Step 1: Gather Index Health Data

Run checkup to get current index status:
```bash
postgresai checkup "$DB_CONNECTION" --check-id H001,H002,H004
```

This generates:
- H001: Invalid indexes (broken/corrupted)
- H002: Unused indexes (candidates for removal)
- H004: Redundant indexes (duplicates)

### Step 2: Analyze Findings

For each category:

#### Invalid Indexes (H001) - HIGH PRIORITY
- These indexes are broken and provide no benefit
- They consume space and slow down writes
- **Safe to rebuild or drop**

#### Unused Indexes (H002) - MEDIUM PRIORITY
- Check `idx_scan` count (should be > 0 for useful indexes)
- Verify stats reset time to ensure sufficient observation period
- Check if index supports foreign keys before dropping

#### Redundant Indexes (H004) - MEDIUM PRIORITY
- Identify which index is the "superset"
- Keep the more efficient/complete index
- Verify no unique constraints depend on the redundant one

### Step 3: Generate Fix Plan

For each issue, generate SQL with safety notes:

```sql
-- Invalid Index Fix (H001)
-- Option A: Rebuild
REINDEX INDEX CONCURRENTLY schema.index_name;

-- Option B: Drop and recreate
DROP INDEX CONCURRENTLY IF EXISTS schema.index_name;
CREATE INDEX CONCURRENTLY index_name ON schema.table (...);

-- Unused Index Fix (H002)
-- Verify FK dependency first
SELECT conname FROM pg_constraint
WHERE conindid = 'schema.index_name'::regclass;

-- If no FK, safe to drop
DROP INDEX CONCURRENTLY IF EXISTS schema.index_name;

-- Redundant Index Fix (H004)
-- Drop the redundant one, keep the superset
DROP INDEX CONCURRENTLY IF EXISTS schema.redundant_index_name;
```

### Step 4: Safety Checks

Before ANY index operation:
1. Confirm this is not a production-critical index
2. Check for active queries using the index
3. Estimate lock duration
4. Verify CONCURRENTLY option is used

### Step 5: Execution (ADVISE Mode)

Present the fix plan and wait for approval:

```
=== Index Fix Plan ===

Invalid Indexes to Rebuild:
1. schema.idx_name - 45MB - Reason: ...

Unused Indexes to Drop:
1. schema.unused_idx - 120MB - 0 scans in 30 days

Redundant Indexes to Drop:
1. schema.redundant_idx - 80MB - covered by schema.superset_idx

Estimated space savings: 245MB
Estimated execution time: 2-5 minutes

[ ] Approve and execute
[ ] Modify plan
[ ] Cancel
```

### Step 6: Document

Create or update issue with findings:
```bash
postgresai issues create "Index Health: N issues found" --labels "index,maintenance"
```

## Output Format

```
=== Index Health Analysis ===

## Summary
- Invalid indexes: N (HIGH priority)
- Unused indexes: N (MEDIUM priority)
- Redundant indexes: N (MEDIUM priority)
- Total wasted space: X MB

## Detailed Findings

### Invalid Indexes
| Index | Table | Size | Action |
|-------|-------|------|--------|
| ... | ... | ... | REBUILD |

### Unused Indexes
| Index | Table | Size | Scans | Action |
|-------|-------|------|-------|--------|
| ... | ... | ... | 0 | DROP |

### Redundant Indexes
| Index | Redundant To | Size | Action |
|-------|-------------|------|--------|
| ... | ... | ... | DROP |

## Recommended Actions
[List of SQL commands with CONCURRENTLY]

## Risk Assessment
- Lock impact: MINIMAL (using CONCURRENTLY)
- Rollback: CREATE INDEX statements provided
```
