# Grafana RCA (Root Cause Analysis)

Use Grafana dashboards to perform deep root cause analysis of database incidents.

## Arguments
- `$ARGUMENTS`: Incident description or time range (e.g., "slow queries last hour" or "2024-01-15 14:00 to 15:00")

## Prerequisites

Ensure monitoring stack is running:
```bash
postgresai mon health
```

Grafana should be accessible at: http://localhost:3000

## Instructions

### Step 1: Determine Investigation Focus

Based on the incident type, identify relevant dashboards:

| Incident Type | Primary Dashboard | Secondary |
|--------------|-------------------|-----------|
| Slow queries | Dashboard 2, 3 | Dashboard 4 |
| High CPU | Dashboard 1 | Dashboard 2 |
| Lock contention | Dashboard 13 | Dashboard 4 |
| Replication lag | Dashboard 6 | Dashboard 5 |
| Table bloat | Dashboard 7 | Dashboard 8 |
| Index issues | Dashboard 10, 11 | Dashboard 2 |

### Step 2: Query Flask Backend for Metrics

The Flask backend provides CSV exports:
```bash
# Get pg_stat_statements metrics for a time range
curl "http://localhost:55000/pgss_metrics/csv?time_start=2024-01-15T14:00:00Z&time_end=2024-01-15T15:00:00Z"
```

### Step 3: Analyze Key Metrics

For performance incidents, check:

**Query Performance (Dashboard 2-3)**
- Total execution time by query
- Mean execution time trends
- Rows processed per query
- Temporary bytes written

**Wait Events (Dashboard 4)**
- Lock waits
- I/O waits
- Buffer pin waits
- CPU waits

**System Resources (Dashboard 1)**
- CPU utilization
- Memory usage
- Disk I/O
- Network traffic

### Step 4: Timeline Reconstruction

Build a timeline of events:
1. When did the issue start?
2. What changed around that time?
3. What metrics correlate with the incident?
4. When did it resolve (if applicable)?

### Step 5: Correlate with Database Activity

Check for:
- Query pattern changes
- New deployments
- Schema changes
- Backup/maintenance windows
- Traffic spikes

### Step 6: Document Findings

Create comprehensive RCA report:

```
=== Root Cause Analysis Report ===

## Incident Summary
- Start Time: [timestamp]
- End Time: [timestamp]
- Duration: [duration]
- Impact: [description]

## Timeline
[Chronological events]

## Root Cause
[Primary cause identified]

## Contributing Factors
- [Factor 1]
- [Factor 2]

## Evidence
[Screenshots/metrics references]

## Remediation Applied
[What was done to resolve]

## Prevention
[How to prevent recurrence]
```

### Step 7: Update Issues

```bash
postgresai issues post-comment "<issue_id>" "RCA Complete: [Summary]"
```

## Dashboard Quick Reference

### Dashboard URLs (Local)
- Node Overview: http://localhost:3000/d/node-performance
- Query Analysis: http://localhost:3000/d/query-analysis
- Wait Sampling: http://localhost:3000/d/wait-sampling
- Autovacuum: http://localhost:3000/d/autovacuum-bloat
- Index Health: http://localhost:3000/d/index-health
- Lock Waits: http://localhost:3000/d/lock-waits

### Key Metrics to Check

**For Slow Query Investigation:**
- `calls` - Number of times query executed
- `total_time` - Cumulative execution time
- `mean_time` - Average execution time
- `rows` - Rows returned
- `shared_blks_hit/read` - Buffer cache efficiency

**For Lock Investigation:**
- `wait_event_type` - Type of wait
- `wait_event` - Specific wait event
- `duration` - How long the wait lasted

**For Resource Investigation:**
- `cpu_utilization` - CPU percentage
- `mem_used` - Memory consumption
- `disk_read_bytes/disk_write_bytes` - I/O activity

## Output Format

```
=== Grafana RCA: [Incident Title] ===

## Quick Summary
[1-2 sentence summary]

## Key Findings
1. [Finding 1 with metric evidence]
2. [Finding 2 with metric evidence]
3. [Finding 3 with metric evidence]

## Root Cause
[Detailed explanation]

## Metrics Evidence
| Metric | Before | During | After |
|--------|--------|--------|-------|
| ... | ... | ... | ... |

## Recommendations
1. [Immediate action]
2. [Short-term fix]
3. [Long-term prevention]

## Links
- [Relevant Grafana dashboard links]
- [Related issues]
```
