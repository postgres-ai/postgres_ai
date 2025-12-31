# PGAI Analyze

Deep-dive analysis of a specific issue from PostgresAI.

## Arguments
- `$ARGUMENTS`: Issue ID to analyze

## Instructions

### Step 1: Fetch Issue Details
```bash
postgresai issues view "$ARGUMENTS"
```

### Step 2: Gather Context

Based on the issue type, gather additional data:

**For performance issues:**
- Check pg_stat_statements metrics
- Review wait events
- Analyze query patterns

**For storage/bloat issues:**
- Check table and index sizes
- Review autovacuum history
- Analyze dead tuple counts

**For replication issues:**
- Check replication lag
- Review WAL statistics
- Analyze connection status

**For index issues:**
- Review index usage statistics
- Check for redundancy
- Validate index definitions

### Step 3: Grafana Deep Dive (if available)

Query relevant Grafana dashboards:
- Dashboard 3 (Single query analysis) for query issues
- Dashboard 7 (Autovacuum) for bloat issues
- Dashboard 10 (Index health) for index issues
- Dashboard 13 (Lock waits) for contention issues

### Step 4: Root Cause Analysis

Provide:
1. **Summary**: What is the issue?
2. **Impact**: How does it affect the system?
3. **Root Cause**: Why is this happening?
4. **Evidence**: Data supporting the analysis
5. **Timeline**: When did this start? (if determinable)

### Step 5: Remediation Plan

Propose a fix with:
1. **Immediate Actions**: Quick fixes for symptoms
2. **Root Fix**: Address underlying cause
3. **Prevention**: How to prevent recurrence
4. **Verification**: How to confirm the fix worked

### Step 6: Update Issue

```bash
postgresai issues post-comment "$ARGUMENTS" "Analysis complete:
[Summary of findings and recommendations]"
```

### Output Format

```
=== Issue Analysis: #ISSUE_ID ===

## Summary
[Brief description]

## Impact Assessment
- Severity: [CRITICAL/HIGH/MEDIUM/LOW]
- Affected: [queries/tables/users]
- Duration: [time estimate]

## Root Cause
[Detailed explanation]

## Evidence
- [Metric 1]: [Value]
- [Metric 2]: [Value]

## Remediation Plan
1. [Step 1]
2. [Step 2]
3. [Step 3]

## Next Steps
[ ] Approve remediation plan
[ ] Execute fixes
[ ] Verify resolution
```
