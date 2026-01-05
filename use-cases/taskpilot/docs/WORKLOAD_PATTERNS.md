# TaskPilot Workload Patterns

This document describes the query patterns and workload characteristics that TaskPilot generates, making it ideal for testing postgres_ai's monitoring and optimization capabilities.

## Query Pattern Categories

### 1. High-Frequency Reads

These queries run constantly and are candidates for index optimization.

#### List Issues (Board View)
```sql
-- ~1000 queries/minute during peak hours
SELECT i.id, i.number, i.title, i.status, i.priority, i.assignee_id,
       u.name as assignee_name, u.avatar_url,
       i.due_date, i.estimate, i.comment_count
FROM issues i
LEFT JOIN users u ON u.id = i.assignee_id
WHERE i.project_id = $1
  AND i.status = $2
  AND i.archived_at IS NULL
ORDER BY i.sort_order
LIMIT 50;

-- Indexes needed:
-- idx_issues_project_status (project_id, status) - partial on archived_at IS NULL
-- idx_issues_sort_order (project_id, sort_order)
```

#### My Issues
```sql
-- ~500 queries/minute
SELECT i.*, p.key as project_key
FROM issues i
JOIN projects p ON p.id = i.project_id
WHERE i.assignee_id = $1
  AND i.status NOT IN ('done', 'cancelled')
  AND i.archived_at IS NULL
ORDER BY
  CASE i.priority
    WHEN 'urgent' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
    ELSE 5
  END,
  i.due_date NULLS LAST;

-- Index needed:
-- idx_issues_assignee_active (assignee_id) WHERE archived_at IS NULL AND status NOT IN (...)
```

#### Recent Activity
```sql
-- ~200 queries/minute
SELECT al.*, u.name as user_name
FROM activity_log al
LEFT JOIN users u ON u.id = al.user_id
WHERE al.organization_id = $1
ORDER BY al.created_at DESC
LIMIT 50;

-- Index needed:
-- idx_activity_log_org_recent (organization_id, created_at DESC)
```

### 2. Write-Heavy Operations

These generate bloat and require monitoring.

#### Status Updates (Hot Path)
```sql
-- ~100 updates/minute
-- This is the #1 source of bloat in the issues table

UPDATE issues
SET status = $2,
    updated_at = NOW()
WHERE id = $1;

-- Triggers:
-- 1. Updated_at trigger fires
-- 2. Activity log insert (200-500 bytes each)
-- 3. Notification inserts for watchers (200-300 bytes each)
-- 4. Webhook delivery queue insert

-- Bloat impact:
-- Each status change creates ~500 bytes of dead tuples in issues table
-- With 100 updates/minute = ~3 MB/hour of bloat
```

#### Comment Creation
```sql
-- ~50 inserts/minute
INSERT INTO comments (issue_id, user_id, body, created_at)
VALUES ($1, $2, $3, NOW())
RETURNING id;

-- Followed by:
UPDATE issues SET comment_count = comment_count + 1 WHERE id = $1;

-- And triggers create:
-- 1. Activity log entry
-- 2. Notifications for issue watchers
-- 3. Mentions parsing -> more notifications
```

#### Notification Mark as Read
```sql
-- ~500 updates/minute (high bloat source)
UPDATE notifications
SET read_at = NOW()
WHERE id = $1 AND user_id = $2;

-- Bulk mark as read:
UPDATE notifications
SET read_at = NOW()
WHERE user_id = $1 AND read_at IS NULL;

-- This is a major bloat contributor!
-- Consider: UNLOGGED table or separate read-tracking
```

### 3. Search Queries

Complex queries that benefit from proper indexing.

#### Full-Text Search
```sql
-- ~20 queries/minute
SELECT i.id, i.number, i.title, i.status,
       ts_rank(i.search_vector, query) as rank
FROM issues i,
     to_tsquery('english', $1) query
WHERE i.project_id = $2
  AND i.search_vector @@ query
  AND i.archived_at IS NULL
ORDER BY rank DESC
LIMIT 20;

-- Index: idx_issues_search_vector USING gin(search_vector)
```

#### Fuzzy Search (Trigram)
```sql
-- ~10 queries/minute
SELECT i.id, i.number, i.title,
       similarity(i.title, $1) as sim
FROM issues i
WHERE i.project_id = $2
  AND i.title % $1
ORDER BY sim DESC
LIMIT 10;

-- Index: idx_issues_title_trgm USING gin(title gin_trgm_ops)
```

### 4. Analytics Queries (Heavy)

Run less frequently but are resource-intensive.

#### Organization Dashboard
```sql
-- ~10 queries/minute (cached in app layer)
SELECT
    p.id,
    p.name,
    COUNT(i.id) as total_issues,
    COUNT(i.id) FILTER (WHERE i.status = 'in_progress') as in_progress,
    COUNT(i.id) FILTER (WHERE i.status = 'done'
                        AND i.completed_at > NOW() - INTERVAL '7 days') as completed_this_week,
    COUNT(i.id) FILTER (WHERE i.due_date < CURRENT_DATE
                        AND i.status NOT IN ('done', 'cancelled')) as overdue,
    AVG(EXTRACT(EPOCH FROM (i.completed_at - i.created_at))/3600)
      FILTER (WHERE i.completed_at IS NOT NULL) as avg_cycle_time_hours
FROM projects p
LEFT JOIN issues i ON i.project_id = p.id
WHERE p.organization_id = $1
  AND p.status = 'active'
GROUP BY p.id, p.name;

-- This query benefits from materialized view: mv_project_overview
```

#### Velocity Report
```sql
-- ~5 queries/minute
WITH weekly_data AS (
    SELECT
        date_trunc('week', i.completed_at) as week,
        COUNT(*) as issues_completed,
        SUM(i.estimate) as points_completed
    FROM issues i
    WHERE i.project_id = $1
      AND i.completed_at >= NOW() - INTERVAL '12 weeks'
      AND i.status = 'done'
    GROUP BY date_trunc('week', i.completed_at)
)
SELECT
    week,
    issues_completed,
    points_completed,
    AVG(issues_completed) OVER (ORDER BY week ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) as moving_avg
FROM weekly_data
ORDER BY week;

-- Materialized view: mv_project_weekly_velocity
```

### 5. Background Job Queries

Automated processes that run on schedule.

#### SLA Check (Every Minute)
```sql
-- Finds issues about to breach SLA
SELECT i.id, i.created_at, sp.targets->>'first_response_hours' as target_hours
FROM issues i
JOIN sla_policies sp ON sp.organization_id = (
    SELECT organization_id FROM projects WHERE id = i.project_id
)
LEFT JOIN sla_status ss ON ss.issue_id = i.id
WHERE i.created_at < NOW() - (
    (sp.targets->>'first_response_hours')::int * INTERVAL '1 hour'
)
AND ss.first_response_at IS NULL
AND ss.first_response_breached = false
AND i.status NOT IN ('done', 'cancelled');

-- Needs careful indexing on created_at and joins
```

#### Recurring Issue Creation (Every Hour)
```sql
SELECT ric.*
FROM recurring_issue_configs ric
WHERE ric.is_active = true
  AND ric.next_run_at <= NOW()
ORDER BY ric.next_run_at
LIMIT 100;

-- Index: idx_recurring_configs_next_run
```

#### Webhook Retry (Every Minute)
```sql
SELECT wd.*
FROM webhook_deliveries wd
WHERE wd.delivered_at IS NULL
  AND wd.next_retry_at <= NOW()
  AND wd.attempt_number < 5
ORDER BY wd.next_retry_at
LIMIT 50;

-- Index: idx_webhook_deliveries_retry
```

## Workload Distribution

### By Time of Day (UTC)

| Hour Range | Activity Level | Primary Workload |
|------------|----------------|------------------|
| 00:00-06:00 | Low (10%) | Background jobs, cron |
| 06:00-09:00 | Ramping (40%) | Dashboard loads, email catch-up |
| 09:00-12:00 | Peak (100%) | Active development, updates |
| 12:00-14:00 | Medium (60%) | Reduced during lunch |
| 14:00-18:00 | Peak (100%) | Afternoon development |
| 18:00-21:00 | Medium (50%) | End of day, some remote workers |
| 21:00-00:00 | Low (20%) | Background jobs, late workers |

### By Query Type

| Query Type | Percentage | Avg Latency Target |
|------------|------------|-------------------|
| Issue List (simple) | 35% | < 50ms |
| Issue List (filtered) | 20% | < 100ms |
| Issue Detail | 15% | < 30ms |
| Comments List | 10% | < 50ms |
| Search | 5% | < 500ms |
| Analytics | 5% | < 2s |
| Writes (INSERT) | 5% | < 100ms |
| Writes (UPDATE) | 5% | < 100ms |

## Expected postgres_ai Findings

### Week 1-2: Missing Indexes
- Issues filtered by assignee without index
- Comments ordered by created_at without index
- Activity log queries scanning full table

### Week 3-4: Bloat Detection
- Issues table: 15-20% bloat from status updates
- Notifications table: 30-40% bloat from read updates
- Need autovacuum tuning recommendations

### Week 5-6: Query Performance
- Search queries using sequential scans
- Dashboard queries with suboptimal plans
- N+1 patterns in some endpoints

### Week 7-8: Lock Contention
- Schema changes causing brief locks
- Heavy update batches causing row-level contention
- Materialized view refreshes

### Week 9-10: Scaling Issues
- Activity log table size growing fast
- Need partitioning recommendations
- Index maintenance overhead

### Week 11-12: Optimization Opportunities
- Redundant indexes identified
- Materialized view refresh strategies
- Connection pool sizing recommendations

## Load Testing Commands

### Standard Workload (50 VUs, 1 hour)
```bash
k6 run scripts/k6/workload.js
```

### High Load (200 VUs, stress test)
```bash
k6 run scripts/k6/workload.js --env VUS=200 --env DURATION=30m
```

### Data Growth (continuous)
```bash
k6 run scripts/k6/scenarios/data-growth.js --duration 24h
```

### Specific Scenario
```bash
# Only dashboard queries
k6 run scripts/k6/workload.js --env SCENARIO=dashboards

# Only write operations
k6 run scripts/k6/workload.js --env SCENARIO=power_users
```

## Monitoring Integration

### Key Metrics to Watch in postgres_ai

1. **Query Performance (K003)**
   - Top queries by total time
   - Queries with high variance
   - Slow query patterns

2. **Bloat (F004/F005)**
   - Tables: issues, notifications, activity_log
   - Indexes on frequently updated columns

3. **Index Usage (H002)**
   - Unused indexes after schema changes
   - Index scans vs sequential scans

4. **Wait Events (N001)**
   - Lock waits during schema changes
   - I/O waits during analytics queries

5. **Connection Patterns**
   - Connection count by application
   - Idle connection accumulation
