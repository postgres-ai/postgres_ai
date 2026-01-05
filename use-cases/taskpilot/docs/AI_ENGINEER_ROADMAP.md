# AI Engineer Roadmap - Schema Change Plan

This document defines the roadmap of schema changes that the simulated AI engineers will make over time. Each change is designed to test specific aspects of postgres_ai's detection capabilities.

## Engineer Profiles

### Alex (Senior Backend Engineer)
- **Experience**: 8 years
- **Tendency**: Generally solid changes, occasionally forgets to add indexes on new foreign keys
- **Focus**: Core feature development, performance optimization
- **Error rate**: ~10% (subtle issues like missing partial indexes)

### Sam (Mid-level Full-stack Engineer)
- **Experience**: 4 years
- **Tendency**: Sometimes creates suboptimal migrations, may add redundant indexes
- **Focus**: UI-driven features, integrations
- **Error rate**: ~25% (redundant indexes, suboptimal data types)

### Jordan (Junior Backend Engineer)
- **Experience**: 1 year
- **Tendency**: Learning, makes typical beginner mistakes
- **Focus**: Bug fixes, small features
- **Error rate**: ~40% (missing indexes, blocking DDL, wrong data types)

## Week 1: Time Tracking Feature

### Day 1 (Alex) - Add time tracking columns to issues ✅
```sql
-- GOOD: Proper column addition with defaults
ALTER TABLE issues ADD COLUMN time_estimate_minutes INTEGER;
ALTER TABLE issues ADD COLUMN time_spent_minutes INTEGER DEFAULT 0;
```

### Day 2 (Sam) - Create time entries table
```sql
-- ISSUE: Missing index on issue_id (foreign key without index)
CREATE TABLE time_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    minutes INTEGER NOT NULL,
    description TEXT,
    date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sam forgets to add: CREATE INDEX idx_time_entries_issue_id ON time_entries(issue_id);
-- postgres_ai should detect: FK without supporting index
```

### Day 3 (Jordan) - Add billable flag
```sql
-- ISSUE: Using TEXT instead of BOOLEAN
ALTER TABLE time_entries ADD COLUMN is_billable TEXT DEFAULT 'false';
-- Should be: BOOLEAN DEFAULT false

-- postgres_ai should detect: Suboptimal data type
```

### Day 4 (Alex) - Fix Jordan's mistake + add proper index
```sql
-- GOOD: Proper fix with migration
ALTER TABLE time_entries DROP COLUMN is_billable;
ALTER TABLE time_entries ADD COLUMN is_billable BOOLEAN DEFAULT false;
CREATE INDEX idx_time_entries_issue_id ON time_entries(issue_id);
```

### Day 5 (Sam) - Add time tracking summary view
```sql
-- GOOD: Useful materialized view
CREATE MATERIALIZED VIEW mv_issue_time_summary AS
SELECT
    issue_id,
    SUM(minutes) as total_minutes,
    COUNT(*) as entry_count,
    MAX(date) as last_entry_date
FROM time_entries
GROUP BY issue_id;

CREATE UNIQUE INDEX idx_mv_issue_time_summary ON mv_issue_time_summary(issue_id);
```

---

## Week 2: Custom Fields

### Day 6 (Alex) - Add custom fields JSONB column
```sql
-- GOOD: JSONB for flexible schema
ALTER TABLE issues ADD COLUMN custom_fields JSONB DEFAULT '{}'::jsonb;
CREATE INDEX idx_issues_custom_fields ON issues USING gin(custom_fields);
```

### Day 7 (Sam) - Create custom field definitions table
```sql
-- ISSUE: Redundant index (name is already in the unique constraint)
CREATE TABLE custom_field_definitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    field_type VARCHAR(20) NOT NULL, -- 'text', 'number', 'date', 'select'
    options JSONB, -- for select type
    is_required BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT custom_field_def_unique UNIQUE (project_id, name)
);

CREATE INDEX idx_custom_field_def_project ON custom_field_definitions(project_id);
CREATE INDEX idx_custom_field_def_name ON custom_field_definitions(name); -- REDUNDANT!

-- postgres_ai should detect: H004 Redundant index
```

### Day 8 (Jordan) - Add default value column
```sql
-- ISSUE: Large DEFAULT causing table rewrite
ALTER TABLE custom_field_definitions
ADD COLUMN default_value TEXT DEFAULT 'This is a very long default value that will cause issues...';

-- Should use: ADD COLUMN default_value TEXT; (no default, or NULL)
-- postgres_ai should detect: Potentially blocking DDL (though PG11+ handles this better)
```

### Day 9-10 (Alex) - Add field validation
```sql
-- GOOD: Proper constraint addition
ALTER TABLE custom_field_definitions
ADD COLUMN validation_regex TEXT,
ADD COLUMN validation_message TEXT;

-- Add check constraint for field_type enum
ALTER TABLE custom_field_definitions
ADD CONSTRAINT custom_field_type_check
CHECK (field_type IN ('text', 'number', 'date', 'select', 'multiselect', 'user'));
```

---

## Week 3: Full-Text Search

### Day 11 (Alex) - Add tsvector column for search
```sql
-- GOOD: Proper FTS setup
ALTER TABLE issues ADD COLUMN search_vector tsvector;

CREATE INDEX idx_issues_search_vector ON issues USING gin(search_vector);

-- Trigger to update search vector
CREATE OR REPLACE FUNCTION issues_search_trigger()
RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tsvector_update_trigger
BEFORE INSERT OR UPDATE OF title, description ON issues
FOR EACH ROW EXECUTE FUNCTION issues_search_trigger();
```

### Day 12 (Sam) - Add trigram index for fuzzy search
```sql
-- ISSUE: Creating ANOTHER search index that partially overlaps
CREATE INDEX idx_issues_title_trgm ON issues USING gin(title gin_trgm_ops);
CREATE INDEX idx_issues_desc_trgm ON issues USING gin(description gin_trgm_ops);

-- postgres_ai might flag: Consider if both FTS and trigram are needed
```

### Day 13 (Jordan) - Add search to comments
```sql
-- ISSUE: Missing the trigger, just adds column
ALTER TABLE comments ADD COLUMN search_vector tsvector;
CREATE INDEX idx_comments_search ON comments USING gin(search_vector);

-- Forgets to create trigger! search_vector will always be NULL
-- postgres_ai should detect: Column that's always NULL (after data populates)
```

### Day 14-15 (Alex) - Fix comment search + add unified search view
```sql
-- Fix Jordan's mistake
CREATE OR REPLACE FUNCTION comments_search_trigger()
RETURNS trigger AS $$
BEGIN
    NEW.search_vector := to_tsvector('english', COALESCE(NEW.body, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER comments_tsvector_trigger
BEFORE INSERT OR UPDATE OF body ON comments
FOR EACH ROW EXECUTE FUNCTION comments_search_trigger();

-- Backfill existing data
UPDATE comments SET search_vector = to_tsvector('english', COALESCE(body, ''));
```

---

## Week 4: SLA Tracking

### Day 16 (Sam) - Add SLA tables
```sql
-- MIXED: Table structure okay, but missing important indexes
CREATE TABLE sla_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    conditions JSONB NOT NULL, -- {"priority": ["high", "urgent"]}
    targets JSONB NOT NULL, -- {"first_response_hours": 4, "resolution_hours": 24}
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE sla_status (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    policy_id UUID NOT NULL REFERENCES sla_policies(id),
    first_response_at TIMESTAMP WITH TIME ZONE,
    first_response_breached BOOLEAN DEFAULT false,
    resolution_at TIMESTAMP WITH TIME ZONE,
    resolution_breached BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Missing: Index on issue_id for SLA lookups
-- Missing: Index on organization_id for policy lookups
-- postgres_ai should detect: Missing indexes on FKs
```

### Day 17 (Jordan) - Add SLA breach notifications
```sql
-- ISSUE: Creating new notification type without updating enum
-- This will fail at runtime when trying to insert!
INSERT INTO notifications (user_id, type, title)
VALUES ('...', 'sla_breach', 'SLA Breached!');

-- Should first: ALTER TYPE notification_type ADD VALUE 'sla_breach';
```

### Day 18-19 (Alex) - Fix SLA issues
```sql
-- Add missing enum value
ALTER TYPE notification_type ADD VALUE 'sla_breach';

-- Add missing indexes
CREATE INDEX idx_sla_policies_org ON sla_policies(organization_id);
CREATE INDEX idx_sla_policies_active ON sla_policies(organization_id, is_active)
    WHERE is_active = true;
CREATE INDEX idx_sla_status_issue ON sla_status(issue_id);
CREATE INDEX idx_sla_status_breached ON sla_status(issue_id)
    WHERE first_response_breached = true OR resolution_breached = true;
```

### Day 20 (Sam) - Add SLA metrics materialized view
```sql
-- GOOD: Useful for reporting
CREATE MATERIALIZED VIEW mv_sla_metrics AS
SELECT
    sp.organization_id,
    sp.id as policy_id,
    sp.name as policy_name,
    COUNT(ss.id) as total_issues,
    COUNT(ss.id) FILTER (WHERE ss.first_response_breached) as first_response_breaches,
    COUNT(ss.id) FILTER (WHERE ss.resolution_breached) as resolution_breaches,
    AVG(EXTRACT(EPOCH FROM (ss.first_response_at - i.created_at))/3600)::numeric(10,2) as avg_first_response_hours
FROM sla_policies sp
LEFT JOIN sla_status ss ON ss.policy_id = sp.id
LEFT JOIN issues i ON i.id = ss.issue_id
GROUP BY sp.organization_id, sp.id, sp.name;

CREATE UNIQUE INDEX idx_mv_sla_metrics ON mv_sla_metrics(policy_id);
```

---

## Week 5: API Rate Limiting

### Day 21 (Alex) - Add rate limiting table
```sql
-- GOOD: Proper rate limiting schema
CREATE TABLE api_rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    endpoint_pattern VARCHAR(200) NOT NULL,
    requests_per_minute INTEGER NOT NULL DEFAULT 100,
    requests_per_hour INTEGER NOT NULL DEFAULT 1000,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE api_request_log (
    id BIGSERIAL PRIMARY KEY,
    organization_id UUID NOT NULL,
    user_id UUID,
    token_id UUID,
    endpoint VARCHAR(200) NOT NULL,
    method VARCHAR(10) NOT NULL,
    status_code INTEGER,
    response_time_ms INTEGER,
    ip_address INET,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Proper indexes
CREATE INDEX idx_api_request_log_org_time ON api_request_log(organization_id, created_at DESC);
CREATE INDEX idx_api_request_log_token ON api_request_log(token_id, created_at DESC)
    WHERE token_id IS NOT NULL;
```

### Day 22 (Sam) - Add request body logging
```sql
-- ISSUE: Adding large TEXT column that will bloat table
ALTER TABLE api_request_log ADD COLUMN request_body TEXT;
ALTER TABLE api_request_log ADD COLUMN response_body TEXT;

-- This will significantly increase table size and bloat
-- Should consider: Separate table or no logging of bodies
-- postgres_ai should flag: Table size growth concern
```

### Day 23 (Jordan) - Try to add index on request_body
```sql
-- ISSUE: Index on TEXT column without any limits
CREATE INDEX idx_api_request_log_body ON api_request_log(request_body);

-- This will fail or create huge index!
-- Should use: partial index, expression index, or GIN with tsvector
```

### Day 24-25 (Alex) - Fix and optimize
```sql
-- Remove the problematic index
DROP INDEX IF EXISTS idx_api_request_log_body;

-- Add proper solution for searching
ALTER TABLE api_request_log ADD COLUMN request_body_hash VARCHAR(64);

CREATE INDEX idx_api_request_log_body_hash ON api_request_log(request_body_hash)
    WHERE request_body_hash IS NOT NULL;

-- Consider partitioning for this high-volume table
-- (Week 11 will implement this)
```

---

## Week 6: Issue Templates

### Day 26 (Sam) - Create issue templates table
```sql
-- GOOD: Reasonable schema
CREATE TABLE issue_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    title_template VARCHAR(500),
    description_template TEXT,
    default_status issue_status DEFAULT 'backlog',
    default_priority issue_priority DEFAULT 'none',
    default_labels UUID[], -- Array of label IDs
    default_assignee_id UUID REFERENCES users(id),
    custom_fields JSONB DEFAULT '{}'::jsonb,
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_issue_templates_project ON issue_templates(project_id);
```

### Day 27 (Jordan) - Add template usage tracking
```sql
-- ISSUE: Wrong FK constraint (points to wrong table)
ALTER TABLE issues ADD COLUMN template_id UUID REFERENCES issue_templates(id);

-- Forgets index
-- postgres_ai should detect: Missing index on new FK
```

### Day 28 (Alex) - Add template index + usage stats
```sql
-- Fix missing index
CREATE INDEX idx_issues_template ON issues(template_id) WHERE template_id IS NOT NULL;

-- Add usage counter (denormalized for performance)
ALTER TABLE issue_templates ADD COLUMN usage_count INTEGER DEFAULT 0;
```

### Day 29-30 (Sam) - Template versioning
```sql
-- MIXED: Good idea, execution has issues
CREATE TABLE issue_template_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id UUID NOT NULL REFERENCES issue_templates(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    title_template VARCHAR(500),
    description_template TEXT,
    default_status issue_status,
    default_priority issue_priority,
    custom_fields JSONB,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ISSUE: Redundant unique constraint index
ALTER TABLE issue_template_versions
ADD CONSTRAINT template_version_unique UNIQUE (template_id, version);

CREATE INDEX idx_template_versions_template ON issue_template_versions(template_id);
CREATE INDEX idx_template_versions_unique ON issue_template_versions(template_id, version);
-- ^^^ REDUNDANT with the unique constraint!

-- postgres_ai should detect: H004 Redundant index
```

---

## Week 7: Recurring Issues

### Day 31 (Alex) - Recurring issue configuration
```sql
-- GOOD: Proper recurring issue schema
CREATE TABLE recurring_issue_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    template_id UUID REFERENCES issue_templates(id) ON DELETE SET NULL,
    created_by UUID NOT NULL REFERENCES users(id),

    -- Schedule (cron-like)
    schedule_type VARCHAR(20) NOT NULL, -- 'daily', 'weekly', 'monthly', 'cron'
    schedule_value VARCHAR(100), -- cron expression or day of week/month
    timezone VARCHAR(50) DEFAULT 'UTC',

    -- Issue details
    title_pattern VARCHAR(500) NOT NULL,
    description_pattern TEXT,
    default_assignee_id UUID REFERENCES users(id),

    -- Control
    is_active BOOLEAN DEFAULT true,
    next_run_at TIMESTAMP WITH TIME ZONE,
    last_run_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_recurring_configs_project ON recurring_issue_configs(project_id);
CREATE INDEX idx_recurring_configs_next_run ON recurring_issue_configs(next_run_at)
    WHERE is_active = true;
```

### Day 32 (Jordan) - Track created issues
```sql
-- ISSUE: Using VARCHAR for UUID relationship
CREATE TABLE recurring_issue_history (
    id SERIAL PRIMARY KEY,
    config_id VARCHAR(36) NOT NULL, -- Should be UUID!
    issue_id VARCHAR(36) NOT NULL,  -- Should be UUID!
    scheduled_for TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- postgres_ai should flag: Inconsistent data types for FK relationships
```

### Day 33-34 (Sam) - Add failure tracking
```sql
-- MIXED: Adds useful columns but with issues
ALTER TABLE recurring_issue_history
ADD COLUMN status VARCHAR(20) DEFAULT 'success', -- Should be ENUM
ADD COLUMN error_message TEXT,
ADD COLUMN retry_count INTEGER DEFAULT 0;

-- Adding index on status without considering cardinality
CREATE INDEX idx_recurring_history_status ON recurring_issue_history(status);
-- ^^^ Low cardinality index (only ~3 values) - not very useful
```

### Day 35 (Alex) - Cleanup and fixes
```sql
-- Fix the UUID columns (requires migration)
ALTER TABLE recurring_issue_history
ALTER COLUMN config_id TYPE UUID USING config_id::uuid,
ALTER COLUMN issue_id TYPE UUID USING issue_id::uuid;

-- Add proper foreign keys
ALTER TABLE recurring_issue_history
ADD CONSTRAINT fk_recurring_history_config
FOREIGN KEY (config_id) REFERENCES recurring_issue_configs(id) ON DELETE CASCADE;

-- Add proper composite index
CREATE INDEX idx_recurring_history_config_date
ON recurring_issue_history(config_id, created_at DESC);
```

---

## Week 8: Automation Rules

### Day 36 (Alex) - Automation rules table
```sql
-- GOOD: Well-designed automation schema
CREATE TABLE automation_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id),

    name VARCHAR(100) NOT NULL,
    description TEXT,

    -- Trigger conditions (JSONB for flexibility)
    trigger_event VARCHAR(50) NOT NULL, -- 'issue.created', 'issue.updated', 'comment.added'
    conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Example: [{"field": "status", "operator": "equals", "value": "done"}]

    -- Actions to perform
    actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Example: [{"type": "add_label", "label_id": "..."}]

    -- Control
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0, -- Order of execution

    -- Stats
    run_count INTEGER DEFAULT 0,
    last_run_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_automation_rules_project ON automation_rules(project_id);
CREATE INDEX idx_automation_rules_active ON automation_rules(project_id, is_active, priority)
    WHERE is_active = true;
CREATE INDEX idx_automation_rules_trigger ON automation_rules(trigger_event)
    WHERE is_active = true;
```

### Day 37 (Sam) - Automation execution log
```sql
-- ISSUE: Missing partitioning for high-volume log table
CREATE TABLE automation_execution_log (
    id BIGSERIAL PRIMARY KEY,
    rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    trigger_event VARCHAR(50) NOT NULL,
    conditions_matched JSONB,
    actions_executed JSONB,
    success BOOLEAN NOT NULL,
    error_message TEXT,
    execution_time_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Only one index
CREATE INDEX idx_automation_log_rule ON automation_execution_log(rule_id);

-- Missing: Index on issue_id
-- Missing: Index on created_at for time-range queries
-- This table will grow fast and needs partitioning (Week 11)
```

### Day 38-39 (Jordan) - Add batch processing
```sql
-- ISSUE: Blocking DDL - adding NOT NULL without default
ALTER TABLE automation_execution_log ADD COLUMN batch_id UUID NOT NULL;

-- This will fail on existing data!
-- Should be: ADD COLUMN batch_id UUID; (allow null first, backfill, then add constraint)
```

### Day 40 (Alex) - Fix batch_id and add missing indexes
```sql
-- Proper approach
ALTER TABLE automation_execution_log ADD COLUMN batch_id UUID;

CREATE INDEX idx_automation_log_issue ON automation_execution_log(issue_id);
CREATE INDEX idx_automation_log_created ON automation_execution_log(created_at DESC);
CREATE INDEX idx_automation_log_batch ON automation_execution_log(batch_id)
    WHERE batch_id IS NOT NULL;
```

---

## Week 9: Analytics Tables

### Day 41 (Alex) - Project metrics table
```sql
-- GOOD: Proper analytics schema with time bucketing
CREATE TABLE project_daily_metrics (
    id BIGSERIAL PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    date DATE NOT NULL,

    -- Issue metrics
    issues_created INTEGER DEFAULT 0,
    issues_completed INTEGER DEFAULT 0,
    issues_reopened INTEGER DEFAULT 0,

    -- Velocity
    points_completed DECIMAL(10,2) DEFAULT 0,
    points_added DECIMAL(10,2) DEFAULT 0,

    -- Activity
    comments_added INTEGER DEFAULT 0,
    time_logged_minutes INTEGER DEFAULT 0,

    -- Response times (in minutes)
    avg_first_response_time INTEGER,
    avg_resolution_time INTEGER,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT project_metrics_unique UNIQUE (project_id, date)
);

CREATE INDEX idx_project_metrics_project_date
ON project_daily_metrics(project_id, date DESC);
```

### Day 42 (Sam) - User activity metrics
```sql
-- ISSUE: Too many columns, should be normalized
CREATE TABLE user_daily_metrics (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,

    -- This is getting out of hand...
    issues_created INTEGER DEFAULT 0,
    issues_assigned INTEGER DEFAULT 0,
    issues_completed INTEGER DEFAULT 0,
    comments_made INTEGER DEFAULT 0,
    time_logged_minutes INTEGER DEFAULT 0,
    reactions_given INTEGER DEFAULT 0,
    reactions_received INTEGER DEFAULT 0,
    labels_added INTEGER DEFAULT 0,
    labels_removed INTEGER DEFAULT 0,
    attachments_uploaded INTEGER DEFAULT 0,
    mentions_made INTEGER DEFAULT 0,
    mentions_received INTEGER DEFAULT 0,
    cycle_updates INTEGER DEFAULT 0,
    status_changes INTEGER DEFAULT 0,
    priority_changes INTEGER DEFAULT 0,
    estimate_changes INTEGER DEFAULT 0,
    -- ... imagine 20 more columns

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT user_metrics_unique UNIQUE (user_id, date)
);

-- Narrow table alternative would be better for sparse data
```

### Day 43 (Jordan) - Add real-time counters
```sql
-- ISSUE: Using SERIALIZABLE for a counter table (performance killer)
-- Also using LOCK for updates

-- This is in application code but worth noting
-- BEGIN ISOLATION LEVEL SERIALIZABLE;
-- SELECT * FROM project_daily_metrics WHERE project_id = '...' FOR UPDATE;
-- UPDATE project_daily_metrics SET issues_created = issues_created + 1 ...;
-- COMMIT;

-- Creates contention - should use INSERT ON CONFLICT DO UPDATE instead
```

### Day 44-45 (Alex) - Add materialized views for dashboards
```sql
-- GOOD: Efficient pre-aggregation
CREATE MATERIALIZED VIEW mv_project_weekly_velocity AS
SELECT
    project_id,
    date_trunc('week', date) as week,
    SUM(issues_completed) as issues_completed,
    SUM(points_completed) as points_completed,
    AVG(avg_resolution_time) as avg_resolution_time
FROM project_daily_metrics
GROUP BY project_id, date_trunc('week', date);

CREATE UNIQUE INDEX idx_mv_project_weekly
ON mv_project_weekly_velocity(project_id, week);

-- Organization-level rollup
CREATE MATERIALIZED VIEW mv_org_monthly_metrics AS
SELECT
    p.organization_id,
    date_trunc('month', pdm.date) as month,
    SUM(pdm.issues_created) as issues_created,
    SUM(pdm.issues_completed) as issues_completed,
    SUM(pdm.points_completed) as points_completed,
    SUM(pdm.comments_added) as comments_added
FROM project_daily_metrics pdm
JOIN projects p ON p.id = pdm.project_id
GROUP BY p.organization_id, date_trunc('month', pdm.date);

CREATE UNIQUE INDEX idx_mv_org_monthly
ON mv_org_monthly_metrics(organization_id, month);
```

---

## Week 10: External Integrations

### Day 46 (Sam) - External sync status table
```sql
-- MIXED: Good idea but some issues
CREATE TABLE external_integrations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    provider VARCHAR(50) NOT NULL, -- 'github', 'gitlab', 'slack', 'jira'
    config JSONB NOT NULL, -- Encrypted API tokens, etc.
    status VARCHAR(20) DEFAULT 'active',
    last_sync_at TIMESTAMP WITH TIME ZONE,
    sync_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE issue_external_links (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    integration_id UUID NOT NULL REFERENCES external_integrations(id) ON DELETE CASCADE,
    external_id VARCHAR(200) NOT NULL,
    external_url TEXT NOT NULL,
    sync_status VARCHAR(20) DEFAULT 'synced',
    last_synced_at TIMESTAMP WITH TIME ZONE,
    external_data JSONB, -- Cached data from external system
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Missing: Index on issue_id
-- Missing: Unique constraint on issue_id + integration_id
```

### Day 47 (Jordan) - Add GitHub PR linking
```sql
-- ISSUE: Creates table very similar to issue_external_links
CREATE TABLE github_pull_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id UUID NOT NULL REFERENCES issues(id),
    pr_number INTEGER NOT NULL,
    pr_url TEXT NOT NULL,
    pr_title TEXT,
    pr_status VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Should have used issue_external_links instead!
-- postgres_ai might flag: Schema duplication
```

### Day 48 (Alex) - Fix external links indexing
```sql
-- Add missing indexes
CREATE INDEX idx_issue_external_links_issue ON issue_external_links(issue_id);
CREATE INDEX idx_issue_external_links_external ON issue_external_links(integration_id, external_id);
ALTER TABLE issue_external_links
ADD CONSTRAINT issue_external_links_unique UNIQUE (issue_id, integration_id);

-- Add index on external_integrations
CREATE INDEX idx_external_integrations_org ON external_integrations(organization_id);
```

### Day 49-50 (Sam) - Webhook delivery tracking
```sql
-- GOOD: Proper webhook delivery log
CREATE TABLE webhook_deliveries (
    id BIGSERIAL PRIMARY KEY,
    webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    response_status INTEGER,
    response_body TEXT,
    response_time_ms INTEGER,
    attempt_number INTEGER DEFAULT 1,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at)
    WHERE next_retry_at IS NOT NULL AND delivered_at IS NULL;
CREATE INDEX idx_webhook_deliveries_created ON webhook_deliveries(created_at DESC);
```

---

## Week 11: Partitioning & Archival

### Day 51 (Alex) - Partition activity_log
```sql
-- GOOD: Proper partitioning implementation

-- Create new partitioned table
CREATE TABLE activity_log_partitioned (
    id UUID DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL,
    project_id UUID,
    issue_id UUID,
    user_id UUID,
    action activity_action NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    changes JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create partitions
CREATE TABLE activity_log_y2025m01 PARTITION OF activity_log_partitioned
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE activity_log_y2025m02 PARTITION OF activity_log_partitioned
    FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
-- ... etc for each month

-- Create indexes on partitions
CREATE INDEX idx_activity_log_part_org ON activity_log_partitioned(organization_id, created_at DESC);
CREATE INDEX idx_activity_log_part_issue ON activity_log_partitioned(issue_id, created_at DESC);
```

### Day 52-53 (Sam) - Partition api_request_log
```sql
-- ISSUE: Forgets to add default partition
CREATE TABLE api_request_log_partitioned (
    id BIGSERIAL,
    organization_id UUID NOT NULL,
    user_id UUID,
    token_id UUID,
    endpoint VARCHAR(200) NOT NULL,
    method VARCHAR(10) NOT NULL,
    status_code INTEGER,
    response_time_ms INTEGER,
    ip_address INET,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Creates current month only
CREATE TABLE api_request_log_current PARTITION OF api_request_log_partitioned
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

-- MISSING: DEFAULT partition for out-of-range data
-- Future inserts beyond 2025-02-01 will FAIL!
```

### Day 54 (Jordan) - Try to drop old partition
```sql
-- ISSUE: Drops partition without backing up or archiving
DROP TABLE activity_log_y2024m01;

-- Should have:
-- 1. Detached partition first: ALTER TABLE activity_log_partitioned DETACH PARTITION activity_log_y2024m01;
-- 2. Archived to cold storage
-- 3. Then dropped if confirmed
```

### Day 55 (Alex) - Add default partitions + cleanup script
```sql
-- Add default partitions
CREATE TABLE api_request_log_default PARTITION OF api_request_log_partitioned DEFAULT;
CREATE TABLE activity_log_default PARTITION OF activity_log_partitioned DEFAULT;

-- Create function for partition management
CREATE OR REPLACE FUNCTION create_monthly_partitions(
    table_name TEXT,
    months_ahead INTEGER DEFAULT 3
)
RETURNS void AS $$
DECLARE
    partition_date DATE;
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    FOR i IN 0..months_ahead LOOP
        partition_date := date_trunc('month', CURRENT_DATE + (i || ' months')::interval);
        start_date := partition_date;
        end_date := partition_date + interval '1 month';
        partition_name := table_name || '_y' || to_char(partition_date, 'YYYY') || 'm' || to_char(partition_date, 'MM');

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
            partition_name, table_name, start_date, end_date
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql;
```

---

## Week 12: Read Replica Optimization

### Day 56 (Alex) - Add read-replica safe views
```sql
-- GOOD: Views designed for read replicas
CREATE VIEW v_issue_board AS
SELECT
    i.id,
    i.project_id,
    i.number,
    i.title,
    i.status,
    i.priority,
    i.assignee_id,
    u.name as assignee_name,
    u.avatar_url as assignee_avatar,
    i.estimate,
    i.due_date,
    i.comment_count,
    array_agg(l.id) FILTER (WHERE l.id IS NOT NULL) as label_ids,
    array_agg(l.name) FILTER (WHERE l.name IS NOT NULL) as label_names,
    array_agg(l.color) FILTER (WHERE l.color IS NOT NULL) as label_colors
FROM issues i
LEFT JOIN users u ON u.id = i.assignee_id
LEFT JOIN issue_labels il ON il.issue_id = i.id
LEFT JOIN labels l ON l.id = il.label_id
WHERE i.archived_at IS NULL
GROUP BY i.id, i.project_id, i.number, i.title, i.status, i.priority,
         i.assignee_id, u.name, u.avatar_url, i.estimate, i.due_date, i.comment_count;
```

### Day 57-58 (Sam) - Add dashboard aggregations
```sql
-- MIXED: Good caching, but refresh strategy unclear
CREATE MATERIALIZED VIEW mv_project_overview AS
SELECT
    p.id as project_id,
    p.name,
    p.key,
    COUNT(DISTINCT i.id) as total_issues,
    COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'backlog') as backlog_count,
    COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'todo') as todo_count,
    COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'in_progress') as in_progress_count,
    COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'done') as done_count,
    COUNT(DISTINCT i.id) FILTER (WHERE i.status = 'cancelled') as cancelled_count,
    COUNT(DISTINCT i.id) FILTER (WHERE i.due_date < CURRENT_DATE AND i.status NOT IN ('done', 'cancelled')) as overdue_count,
    AVG(EXTRACT(EPOCH FROM (i.completed_at - i.created_at))/3600)::numeric(10,2) as avg_resolution_hours
FROM projects p
LEFT JOIN issues i ON i.project_id = p.id
GROUP BY p.id, p.name, p.key;

CREATE UNIQUE INDEX idx_mv_project_overview ON mv_project_overview(project_id);

-- No refresh schedule defined!
-- Should add: pg_cron job to REFRESH MATERIALIZED VIEW CONCURRENTLY
```

### Day 59 (Jordan) - Add query hints
```sql
-- ISSUE: Tries to force index usage with wrong syntax
-- SELECT /*+ IndexScan(issues idx_issues_status) */ * FROM issues WHERE status = 'todo';

-- This Oracle-style hint doesn't work in PostgreSQL!
-- Should use: planner settings or pg_hint_plan extension
```

### Day 60 (Alex) - Final cleanup and documentation
```sql
-- Add table comments for documentation
COMMENT ON TABLE issues IS 'Core work items tracked in TaskPilot';
COMMENT ON COLUMN issues.metadata IS 'Flexible JSON field for custom attributes';
COMMENT ON COLUMN issues.sort_order IS 'Fractional ordering for drag-drop positioning';

COMMENT ON TABLE activity_log_partitioned IS 'Audit trail, partitioned by month for performance';
COMMENT ON TABLE api_request_log_partitioned IS 'API access logs, partitioned by month';

-- Add statistics targets for important columns
ALTER TABLE issues ALTER COLUMN status SET STATISTICS 1000;
ALTER TABLE issues ALTER COLUMN priority SET STATISTICS 1000;
ALTER TABLE issues ALTER COLUMN assignee_id SET STATISTICS 1000;

-- Analyze tables
ANALYZE issues;
ANALYZE comments;
ANALYZE activity_log_partitioned;
```

---

## Summary: Issues for postgres_ai to Detect

| Week | Issue Type | Description |
|------|------------|-------------|
| 1 | Missing FK Index | time_entries.issue_id without index |
| 1 | Wrong Data Type | is_billable as TEXT instead of BOOLEAN |
| 2 | Redundant Index | custom_field_definitions name index |
| 3 | Overlapping Indexes | Both FTS and trigram on same columns |
| 3 | NULL Column | comments.search_vector always NULL |
| 4 | Missing FK Indexes | sla_policies, sla_status |
| 5 | Large TEXT Columns | api_request_log body columns |
| 5 | Bad Index Choice | Index on TEXT column |
| 6 | Missing FK Index | issues.template_id |
| 6 | Redundant Index | template_versions unique |
| 7 | Wrong Data Type | UUIDs stored as VARCHAR |
| 7 | Low Cardinality Index | status column index |
| 8 | Missing Indexes | automation_execution_log |
| 8 | Blocking DDL | NOT NULL without default |
| 9 | Wide Table | user_daily_metrics |
| 10 | Schema Duplication | github_pull_requests vs external_links |
| 11 | Missing Default Partition | api_request_log_partitioned |
| 12 | No Refresh Strategy | mv_project_overview |

## Expected postgres_ai Alerts

- **H002 (Unused Indexes)**: Some indexes created but queries use different patterns
- **H004 (Redundant Indexes)**: Several explicit redundancies
- **F004/F005 (Bloat)**: Heavy updates on issues, notifications
- **K003 (Slow Queries)**: Missing indexes initially, improves over time
- **Missing Index Suggestions**: FK columns without supporting indexes
