# TaskPilot Load Simulation Guide

This document describes how to simulate realistic user load on TaskPilot using k6 load testing.

## Overview

TaskPilot simulates user activity using k6, generating:
- **Read operations**: Dashboard views, issue listings, search
- **Write operations**: Issue creation, comments, status updates
- **Analytics queries**: Heavy aggregation queries

## Database Growth Target

| Timeframe | Issues | Comments | Activity Log | DB Size |
|-----------|--------|----------|--------------|---------|
| Initial | 500K | 2M | 3M | 10 GiB |
| Week 1 | 600K | 2.5M | 4M | 20 GiB |
| Week 4 | 900K | 4M | 7M | 50 GiB |
| Week 8 | 1.3M | 6M | 11M | 90 GiB |
| Week 12 | 1.8M | 8M | 15M | 130 GiB |

## k6 Workload Scenarios

### 1. Regular Users (`regularUserWorkflow`)
- **VUs**: 50 (ramping)
- **Behavior**: Browse projects, view issues, occasional creates
- **Read/Write ratio**: 80/20

```javascript
// Key operations:
- GET /api/v1/projects (dashboard load)
- GET /api/v1/projects/{id}/issues (issue listing)
- GET /api/v1/issues/{id} (issue detail)
- POST /api/v1/issues (30% chance)
- POST /api/v1/issues/{id}/comments (40% chance)
- PATCH /api/v1/issues/{id} (20% chance)
```

### 2. Power Users (`powerUserWorkflow`)
- **VUs**: 5 (constant)
- **Behavior**: Bulk operations, heavy search usage
- **Read/Write ratio**: 50/50

```javascript
// Key operations:
- POST /api/v1/issues (5x in sequence)
- PATCH /api/v1/issues/{id} (10x bulk updates)
- GET /api/v1/search?q=... (5 different queries)
```

### 3. Background Jobs (`backgroundJobWorkflow`)
- **Rate**: 10 requests/second
- **Behavior**: Automated system checks
- **Read only**

```javascript
// Key operations:
- GET /api/v1/internal/sla/check
- GET /api/v1/internal/webhooks/pending
- GET /api/v1/internal/recurring/due
- GET /api/v1/internal/metrics/aggregate
```

### 4. Dashboard Queries (`dashboardWorkflow`)
- **VUs**: 3 (constant)
- **Behavior**: Heavy analytics queries
- **Read only**

```javascript
// Key operations (heavy queries):
- GET /api/v1/analytics/organization
- GET /api/v1/analytics/projects/{id}/velocity
- GET /api/v1/analytics/workload
- GET /api/v1/activity?page=1-5 (pagination test)
```

## Running Load Tests

### Prerequisites

```bash
# Install k6
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### Environment Setup

```bash
# Required for load testing
export TASKPILOT_DEMO_MODE=true
export TASKPILOT_DEMO_PASSWORD=your-test-password-here
```

### Quick Test (5 minutes)

```bash
cd use-cases/taskpilot

# Run with minimal load
k6 run \
  -e BASE_URL=http://localhost:8000 \
  -e VUS=10 \
  -e DURATION=5m \
  scripts/k6/workload.js
```

### Standard Test (1 hour)

```bash
k6 run \
  -e BASE_URL=http://localhost:8000 \
  -e VUS=50 \
  -e DURATION=1h \
  scripts/k6/workload.js
```

### Heavy Load Test (sustained)

```bash
k6 run \
  -e BASE_URL=http://localhost:8000 \
  -e VUS=200 \
  -e DURATION=8h \
  scripts/k6/workload.js
```

### Continuous Load (for growth simulation)

Run continuously to simulate 10 GiB/week growth:

```bash
# Run in background with growth settings
nohup k6 run \
  -e BASE_URL=http://localhost:8000 \
  -e VUS=30 \
  -e DURATION=168h \
  scripts/k6/workload.js > k6.log 2>&1 &
```

## Data Growth Calculations

### Per Hour (50 VUs)
| Operation | Count/Hour | Data Generated |
|-----------|------------|----------------|
| Issues created | ~500 | ~2 MB |
| Comments added | ~400 | ~1 MB |
| Activity logs | ~2,000 | ~3 MB |
| Search queries | ~300 | - |

### Per Day (50 VUs)
- Issues: ~12,000 new
- Comments: ~10,000 new
- Activity: ~50,000 new records
- Growth: ~150 MB

### Per Week (50 VUs, 24/7)
- Issues: ~84,000 new
- Comments: ~70,000 new
- Activity: ~350,000 new records
- **Growth: ~1 GiB**

To reach 10 GiB/week growth, run with 500 VUs:
```bash
k6 run -e VUS=500 -e DURATION=168h scripts/k6/workload.js
```

## Custom Scenarios

### Focus on Writes

```javascript
// scripts/k6/write-heavy.js
export const options = {
  scenarios: {
    writers: {
      executor: 'constant-vus',
      vus: 100,
      duration: '1h',
      exec: 'writeHeavyWorkflow',
    },
  },
};

export function writeHeavyWorkflow() {
  // Create issue
  // Add 5 comments
  // Update status 3 times
}
```

### Focus on Search

```javascript
// scripts/k6/search-heavy.js
export const options = {
  scenarios: {
    searchers: {
      executor: 'constant-vus',
      vus: 50,
      duration: '1h',
      exec: 'searchHeavyWorkflow',
    },
  },
};

export function searchHeavyWorkflow() {
  // Run 10 different search queries
  // Test pagination
  // Test filters
}
```

## Monitoring During Load Tests

### Database Metrics to Watch

```sql
-- Active connections
SELECT count(*) FROM pg_stat_activity WHERE state = 'active';

-- Slow queries
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- Index usage
SELECT indexrelname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC;
```

### postgres_ai Integration

During load tests, postgres_ai should detect:
1. **Slow queries** that need optimization
2. **Missing indexes** causing full table scans
3. **Table bloat** from frequent updates
4. **Connection pool issues**

Run postgres_ai health check during load:
```bash
postgres_ai checkup --run-now
```

## Expected postgres_ai Findings

After running load tests, expect these findings:

| Category | Finding | Cause |
|----------|---------|-------|
| Performance | Slow query on issues.status | Missing composite index |
| Bloat | issues table bloat > 30% | Frequent status updates |
| Index | Unused index on created_at | Wrong column order |
| Vacuum | Tables need VACUUM | High write rate |

## Troubleshooting

### Connection Errors
```bash
# Increase connection pool
export DATABASE_POOL_SIZE=50
export DATABASE_MAX_OVERFLOW=20
```

### Memory Issues
```bash
# Reduce VUs
k6 run -e VUS=20 scripts/k6/workload.js
```

### Slow Responses
Check if database needs:
- VACUUM ANALYZE
- Index rebuilds
- Connection pool increase
