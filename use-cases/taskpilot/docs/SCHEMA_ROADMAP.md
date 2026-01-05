# TaskPilot Schema Development Roadmap

This roadmap defines 12 weeks of schema evolution for TaskPilot. Each week includes 5-7 schema changes made by different engineers. Follow this roadmap when simulating development.

## Database Growth Target

- **Initial size**: 10 GiB (from seed data)
- **Weekly growth**: ~10 GiB (from user activity simulation)
- **Total after 12 weeks**: ~130 GiB

---

## Week 1: Time Tracking Foundation

**Theme**: Core time tracking feature for billable hours

### Day 1 (Monday) - Alex
**Add time tracking columns to issues**
```sql
ALTER TABLE issues ADD COLUMN time_estimate_minutes INTEGER;
ALTER TABLE issues ADD COLUMN time_spent_minutes INTEGER DEFAULT 0;
CREATE INDEX idx_issues_time_estimate ON issues(time_estimate_minutes) WHERE time_estimate_minutes IS NOT NULL;
```

### Day 2 (Tuesday) - Alex
**Create time_entries table**
```sql
CREATE TABLE time_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    minutes INTEGER NOT NULL CHECK (minutes > 0),
    description TEXT,
    date DATE NOT NULL,
    billable BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_time_entries_issue_id ON time_entries(issue_id);
CREATE INDEX idx_time_entries_user_id ON time_entries(user_id);
CREATE INDEX idx_time_entries_date ON time_entries(date DESC);
```

### Day 3 (Wednesday) - Sam
**Add time entry trigger to update issue totals**
```sql
CREATE OR REPLACE FUNCTION update_issue_time_spent()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE issues SET time_spent_minutes = (
        SELECT COALESCE(SUM(minutes), 0) FROM time_entries WHERE issue_id = NEW.issue_id
    ) WHERE id = NEW.issue_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_issue_time_spent
AFTER INSERT OR UPDATE OR DELETE ON time_entries
FOR EACH ROW EXECUTE FUNCTION update_issue_time_spent();
```

### Day 4 (Thursday) - Jordan
**Add time reporting views** (with mistakes)
```sql
-- Jordan forgets indexes and uses poor column choices
CREATE TABLE time_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),  -- Missing NOT NULL!
    project_id UUID REFERENCES projects(id),  -- Missing NOT NULL!
    week_start DATE,
    total_minutes INTEGER,
    billable_minutes INTEGER,
    created_at TIMESTAMP  -- Missing timezone!
);
-- Jordan forgets all FK indexes - postgres_ai H002!
```

### Day 5 (Friday) - Alex
**Fix Jordan's mistakes and add proper reporting**
```sql
-- Alex fixes the issues
ALTER TABLE time_reports ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE time_reports ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE time_reports ALTER COLUMN created_at TYPE TIMESTAMP WITH TIME ZONE;
CREATE INDEX idx_time_reports_user_id ON time_reports(user_id);
CREATE INDEX idx_time_reports_project_id ON time_reports(project_id);
CREATE UNIQUE INDEX idx_time_reports_user_week ON time_reports(user_id, week_start);
```

---

## Week 2: Custom Fields

**Theme**: Flexible custom field system for enterprise customers

### Day 1 (Monday) - Sam
**Create custom_field_definitions table**
```sql
CREATE TABLE custom_field_definitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    field_type VARCHAR(20) NOT NULL,
    options JSONB,
    is_required BOOLEAN DEFAULT false,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT custom_field_def_unique UNIQUE (project_id, name)
);
-- Sam adds redundant index - postgres_ai H004!
CREATE INDEX idx_custom_field_def_project ON custom_field_definitions(project_id);
-- ^ This is redundant with the UNIQUE constraint above!
```

### Day 2 (Tuesday) - Sam
**Add custom_fields JSONB to issues**
```sql
ALTER TABLE issues ADD COLUMN custom_fields JSONB DEFAULT '{}'::jsonb;
CREATE INDEX idx_issues_custom_fields ON issues USING gin(custom_fields);
```

### Day 3 (Wednesday) - Jordan
**Add custom field validation table** (with mistakes)
```sql
CREATE TABLE custom_field_validations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    field_id UUID REFERENCES custom_field_definitions(id),  -- Missing NOT NULL!
    validation_type TEXT,  -- Should be VARCHAR with constraint
    validation_value TEXT,
    error_message TEXT
);
-- No indexes at all! - postgres_ai H002!
```

### Day 4 (Thursday) - Alex
**Add proper custom field history tracking**
```sql
CREATE TABLE custom_field_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    field_definition_id UUID NOT NULL REFERENCES custom_field_definitions(id),
    old_value JSONB,
    new_value JSONB,
    changed_by UUID NOT NULL REFERENCES users(id),
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_custom_field_history_issue ON custom_field_history(issue_id);
CREATE INDEX idx_custom_field_history_time ON custom_field_history(changed_at DESC);
```

---

## Week 3: Full-Text Search

**Theme**: Advanced search capabilities with PostgreSQL FTS

### Day 1 (Monday) - Alex
**Add tsvector column and trigger**
```sql
ALTER TABLE issues ADD COLUMN search_vector tsvector;
CREATE INDEX idx_issues_search_vector ON issues USING gin(search_vector);

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

### Day 2 (Tuesday) - Sam
**Add trigram indexes for fuzzy search**
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_issues_title_trgm ON issues USING gin(title gin_trgm_ops);
-- Sam adds description trigram too (might be overkill)
CREATE INDEX idx_issues_desc_trgm ON issues USING gin(description gin_trgm_ops);
```

### Day 3 (Wednesday) - Alex
**Add search history and popular searches**
```sql
CREATE TABLE search_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query TEXT NOT NULL,
    result_count INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_search_history_user ON search_history(user_id, created_at DESC);

-- Materialized view for popular searches
CREATE MATERIALIZED VIEW popular_searches AS
SELECT query, COUNT(*) as search_count
FROM search_history
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY query
ORDER BY search_count DESC
LIMIT 100;
```

---

## Week 4: SLA Tracking

**Theme**: Service Level Agreement tracking for enterprise

### Day 1 (Monday) - Sam
**Create SLA policies table** (with missing indexes)
```sql
CREATE TABLE sla_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    conditions JSONB NOT NULL,
    targets JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- Sam forgets FK index! - postgres_ai H002!
```

### Day 2 (Tuesday) - Sam
**Create SLA status table** (more missing indexes)
```sql
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
-- Sam forgets FK indexes again! - postgres_ai H002 x2!
```

### Day 3 (Wednesday) - Jordan
**Add SLA breach notifications** (many issues)
```sql
CREATE TABLE sla_breach_notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sla_status_id UUID REFERENCES sla_status(id),  -- Missing NOT NULL
    notification_type TEXT,  -- Should be VARCHAR
    sent_at TIMESTAMP,  -- Missing timezone
    recipient_id UUID REFERENCES users(id)  -- Missing NOT NULL, missing ON DELETE
);
-- No indexes - postgres_ai H002 x2!
```

### Day 4 (Thursday) - Alex
**Add SLA calculation helper functions**
```sql
CREATE OR REPLACE FUNCTION calculate_business_hours(
    start_time TIMESTAMP WITH TIME ZONE,
    end_time TIMESTAMP WITH TIME ZONE
) RETURNS INTEGER AS $$
    -- Returns business hours between two timestamps
    -- Excludes weekends and assumes 9-5 schedule
$$ LANGUAGE plpgsql;

CREATE INDEX idx_sla_status_breached ON sla_status(issue_id)
    WHERE first_response_breached = true OR resolution_breached = true;
```

---

## Week 5: API Rate Limiting

**Theme**: Rate limiting for API access control

### Day 1 (Monday) - Alex
**Create rate limit configuration**
```sql
CREATE TABLE api_rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    endpoint_pattern VARCHAR(200) NOT NULL,
    requests_per_minute INTEGER NOT NULL DEFAULT 100,
    requests_per_hour INTEGER NOT NULL DEFAULT 1000,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_api_rate_limits_org ON api_rate_limits(organization_id);
```

### Day 2 (Tuesday) - Alex
**Create request log table with BRIN index**
```sql
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
-- BRIN index for time-series data
CREATE INDEX idx_api_request_log_time ON api_request_log USING BRIN(created_at);
CREATE INDEX idx_api_request_log_org_time ON api_request_log(organization_id, created_at DESC);
```

### Day 3 (Wednesday) - Sam
**Add API tokens table**
```sql
CREATE TABLE api_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    user_id UUID REFERENCES users(id),  -- Can be null for org-level tokens
    name VARCHAR(100) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    scopes JSONB DEFAULT '[]'::jsonb,
    last_used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- Sam forgets user_id index (it's nullable but still queried)
CREATE INDEX idx_api_tokens_org ON api_tokens(organization_id);
```

---

## Week 6: Issue Templates

**Theme**: Reusable issue templates for common workflows

### Day 1 (Monday) - Sam
**Create issue templates table**
```sql
CREATE TABLE issue_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    title_template VARCHAR(500),
    description_template TEXT,
    default_status issue_status DEFAULT 'backlog',
    default_priority issue_priority DEFAULT 'none',
    default_labels UUID[],
    default_assignee_id UUID REFERENCES users(id),
    custom_fields JSONB DEFAULT '{}'::jsonb,
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_issue_templates_project ON issue_templates(project_id);
```

### Day 2 (Tuesday) - Jordan
**Add template_id to issues** (forgets index)
```sql
ALTER TABLE issues ADD COLUMN template_id UUID REFERENCES issue_templates(id);
-- Jordan forgets the index! - postgres_ai H002!
```

### Day 3 (Wednesday) - Alex
**Fix Jordan's issue and add template history**
```sql
-- Fix the missing index
CREATE INDEX idx_issues_template ON issues(template_id) WHERE template_id IS NOT NULL;

-- Add template usage tracking
CREATE TABLE template_usage_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id UUID NOT NULL REFERENCES issue_templates(id) ON DELETE CASCADE,
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_template_usage_template ON template_usage_log(template_id, created_at DESC);
```

---

## Week 7: Recurring Issues

**Theme**: Automated recurring issue creation

### Day 1 (Monday) - Alex
**Create recurring issue configurations**
```sql
CREATE TABLE recurring_issue_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    template_id UUID REFERENCES issue_templates(id) ON DELETE SET NULL,
    created_by UUID NOT NULL REFERENCES users(id),
    schedule_type VARCHAR(20) NOT NULL CHECK (schedule_type IN ('daily', 'weekly', 'monthly', 'cron')),
    schedule_value VARCHAR(100),
    timezone VARCHAR(50) DEFAULT 'UTC',
    title_pattern VARCHAR(500) NOT NULL,
    description_pattern TEXT,
    default_assignee_id UUID REFERENCES users(id),
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

### Day 2 (Tuesday) - Sam
**Add recurring issue run log**
```sql
CREATE TABLE recurring_issue_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    config_id UUID NOT NULL REFERENCES recurring_issue_configs(id) ON DELETE CASCADE,
    issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);
-- Sam adds an index but forgets the FK index
CREATE INDEX idx_recurring_runs_status ON recurring_issue_runs(status);
-- Missing index on config_id! - postgres_ai H002!
```

---

## Week 8: Automation Rules

**Theme**: Workflow automation engine

### Day 1 (Monday) - Alex
**Create automation rules table**
```sql
CREATE TABLE automation_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    trigger_event VARCHAR(50) NOT NULL,
    conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
    actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0,
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

### Day 2 (Tuesday) - Alex
**Add automation run history**
```sql
CREATE TABLE automation_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    trigger_entity_type VARCHAR(50) NOT NULL,
    trigger_entity_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    actions_executed JSONB,
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX idx_automation_runs_rule ON automation_runs(rule_id, started_at DESC);
CREATE INDEX idx_automation_runs_entity ON automation_runs(trigger_entity_type, trigger_entity_id);
```

### Day 3 (Wednesday) - Jordan
**Add automation action templates** (many issues)
```sql
CREATE TABLE automation_action_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT,  -- Should be VARCHAR
    action_type TEXT,  -- No constraint
    config JSONB,
    organization_id UUID REFERENCES organizations(id)  -- Missing NOT NULL
);
-- No indexes at all! - postgres_ai H002!
```

---

## Week 9: Analytics & Metrics

**Theme**: Project health metrics and dashboards

### Day 1 (Monday) - Alex
**Create project daily metrics table**
```sql
CREATE TABLE project_daily_metrics (
    id BIGSERIAL PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    issues_created INTEGER DEFAULT 0,
    issues_completed INTEGER DEFAULT 0,
    issues_reopened INTEGER DEFAULT 0,
    points_completed DECIMAL(10,2) DEFAULT 0,
    points_added DECIMAL(10,2) DEFAULT 0,
    comments_added INTEGER DEFAULT 0,
    time_logged_minutes INTEGER DEFAULT 0,
    avg_first_response_time INTEGER,
    avg_resolution_time INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT project_metrics_unique UNIQUE (project_id, date)
);
CREATE INDEX idx_project_metrics_project_date ON project_daily_metrics(project_id, date DESC);
```

### Day 2 (Tuesday) - Alex
**Create user productivity metrics**
```sql
CREATE TABLE user_daily_metrics (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    issues_created INTEGER DEFAULT 0,
    issues_completed INTEGER DEFAULT 0,
    comments_added INTEGER DEFAULT 0,
    time_logged_minutes INTEGER DEFAULT 0,
    reviews_completed INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT user_metrics_unique UNIQUE (user_id, date)
);
CREATE INDEX idx_user_metrics_user_date ON user_daily_metrics(user_id, date DESC);
```

### Day 3 (Wednesday) - Sam
**Add organization-level metrics** (missing index)
```sql
CREATE TABLE organization_metrics (
    id BIGSERIAL PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    metric_type VARCHAR(50) NOT NULL,
    metric_date DATE NOT NULL,
    value DECIMAL(20,4) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_org_metrics_type_date ON organization_metrics(metric_type, metric_date DESC);
-- Sam forgets organization_id index! - postgres_ai H002!
```

---

## Week 10: External Integrations

**Theme**: Third-party integrations (Slack, GitHub, etc.)

### Day 1 (Monday) - Sam
**Create external integrations table**
```sql
CREATE TABLE external_integrations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    provider VARCHAR(50) NOT NULL,
    config JSONB NOT NULL,
    credentials JSONB,  -- Encrypted in app layer
    status VARCHAR(20) DEFAULT 'active',
    last_sync_at TIMESTAMP WITH TIME ZONE,
    sync_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_external_integrations_org ON external_integrations(organization_id);
```

### Day 2 (Tuesday) - Sam
**Add issue external links table**
```sql
CREATE TABLE issue_external_links (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    integration_id UUID NOT NULL REFERENCES external_integrations(id) ON DELETE CASCADE,
    external_id VARCHAR(200) NOT NULL,
    external_url TEXT NOT NULL,
    sync_status VARCHAR(20) DEFAULT 'synced',
    last_synced_at TIMESTAMP WITH TIME ZONE,
    external_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT issue_external_links_unique UNIQUE (issue_id, integration_id)
);
CREATE INDEX idx_issue_external_links_issue ON issue_external_links(issue_id);
-- Sam forgets integration_id index! - postgres_ai H002!
```

### Day 3 (Wednesday) - Jordan
**Add sync history** (multiple issues)
```sql
CREATE TABLE integration_sync_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    integration_id UUID REFERENCES external_integrations(id),  -- Missing NOT NULL
    sync_type TEXT,  -- Should be VARCHAR
    records_synced INTEGER,
    errors TEXT,  -- Should be JSONB for structured errors
    started_at TIMESTAMP,  -- Missing timezone
    completed_at TIMESTAMP  -- Missing timezone
);
-- No indexes! - postgres_ai H002!
```

---

## Week 11: Webhooks & Events

**Theme**: Webhook delivery system

### Day 1 (Monday) - Alex
**Create webhook configurations**
```sql
CREATE TABLE webhook_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name VARCHAR(100) NOT NULL,
    url TEXT NOT NULL,
    secret VARCHAR(64),
    events JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT true,
    failure_count INTEGER DEFAULT 0,
    last_triggered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_webhook_configs_org ON webhook_configs(organization_id);
CREATE INDEX idx_webhook_configs_active ON webhook_configs(is_active) WHERE is_active = true;
```

### Day 2 (Tuesday) - Alex
**Create webhook delivery log**
```sql
CREATE TABLE webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    webhook_config_id UUID NOT NULL REFERENCES webhook_configs(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    response_status INTEGER,
    response_body TEXT,
    attempt_count INTEGER DEFAULT 1,
    status VARCHAR(20) DEFAULT 'pending',
    next_retry_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX idx_webhook_deliveries_config ON webhook_deliveries(webhook_config_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at)
    WHERE status = 'pending' AND next_retry_at IS NOT NULL;
```

### Day 3 (Wednesday) - Sam
**Add event bus table for async processing**
```sql
CREATE TABLE event_bus (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- BRIN index for time-series data
CREATE INDEX idx_event_bus_created ON event_bus USING BRIN(created_at);
CREATE INDEX idx_event_bus_pending ON event_bus(status, created_at)
    WHERE status = 'pending';
```

---

## Week 12: Cleanup & Optimization

**Theme**: Archive old data, optimize indexes

### Day 1 (Monday) - Alex
**Create archive tables**
```sql
CREATE TABLE archived_issues (
    LIKE issues INCLUDING ALL
);
CREATE TABLE archived_comments (
    LIKE comments INCLUDING ALL
);
CREATE TABLE archived_activity_log (
    LIKE activity_log INCLUDING ALL
);
```

### Day 2 (Tuesday) - Alex
**Add archive procedures**
```sql
CREATE OR REPLACE PROCEDURE archive_old_data(older_than INTERVAL) AS $$
BEGIN
    -- Archive completed issues older than threshold
    INSERT INTO archived_issues
    SELECT * FROM issues
    WHERE status IN ('done', 'cancelled')
    AND completed_at < NOW() - older_than;

    -- Delete archived issues from main table
    DELETE FROM issues
    WHERE id IN (SELECT id FROM archived_issues);
END;
$$ LANGUAGE plpgsql;
```

### Day 3 (Wednesday) - Jordan
**Attempt to drop unused indexes** (makes a mistake)
```sql
-- Jordan tries to clean up but drops a useful index!
DROP INDEX idx_issues_status;  -- This was actually being used!
-- postgres_ai should have the query history to show this was a mistake
```

### Day 4 (Thursday) - Alex
**Recreate the index Jordan dropped and add table statistics**
```sql
-- Recreate the dropped index
CREATE INDEX idx_issues_status ON issues(status);

-- Add extended statistics for better query planning
CREATE STATISTICS issues_status_priority ON status, priority FROM issues;
ANALYZE issues;
```

### Day 5 (Friday) - Alex
**Add table partitioning for activity_log**
```sql
-- Prepare for partitioning (if needed for growth)
ALTER TABLE activity_log ADD COLUMN partition_key DATE GENERATED ALWAYS AS (DATE(created_at)) STORED;
CREATE INDEX idx_activity_log_partition ON activity_log(partition_key);
```

---

## postgres_ai Findings Summary

After running this roadmap, postgres_ai should detect:

| Finding Code | Description | Expected Count |
|-------------|-------------|----------------|
| H002 | Missing FK index | 12-15 |
| H004 | Redundant index | 3-4 |
| L001 | Unused index | 2-3 |
| L003 | Oversized VARCHAR | 5-8 |
| B001 | Nullable FK columns | 4-5 |
| B002 | Missing ON DELETE | 3-4 |
| P001 | JSONB vs normalized | 2-3 |

These findings represent realistic issues in a fast-moving startup codebase!
