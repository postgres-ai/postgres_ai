# TaskPilot Database Schema

Complete PostgreSQL schema documentation for the TaskPilot issue tracker.

## Overview

TaskPilot uses a multi-tenant architecture with organizations as the root entity. All data is isolated by organization.

## Extensions Required

```sql
-- Performance monitoring (required for postgres_ai)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Full-text search optimization
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN indexes for arrays and JSONB
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

## Enums

```sql
-- Organization billing plans
CREATE TYPE plan_type AS ENUM ('free', 'starter', 'pro', 'enterprise');

-- Issue workflow status
CREATE TYPE issue_status AS ENUM (
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'done',
    'cancelled'
);

-- Issue priority levels
CREATE TYPE issue_priority AS ENUM ('none', 'low', 'medium', 'high', 'urgent');

-- Project status
CREATE TYPE project_status AS ENUM ('active', 'paused', 'archived');

-- Team member roles
CREATE TYPE team_role AS ENUM ('member', 'lead', 'admin');

-- Cycle status
CREATE TYPE cycle_status AS ENUM ('upcoming', 'active', 'completed');

-- Issue link types
CREATE TYPE link_type AS ENUM ('blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicate_of');

-- Activity action types
CREATE TYPE activity_action AS ENUM (
    'created',
    'updated',
    'deleted',
    'commented',
    'status_changed',
    'assigned',
    'labeled',
    'unlabeled',
    'linked',
    'unlinked',
    'moved',
    'archived'
);

-- Notification types
CREATE TYPE notification_type AS ENUM (
    'issue_assigned',
    'issue_mentioned',
    'comment_added',
    'issue_updated',
    'due_date_reminder',
    'cycle_started',
    'cycle_ending'
);
```

## Core Tables

### organizations

Root entity for multi-tenancy.

```sql
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) NOT NULL UNIQUE,
    plan_type plan_type NOT NULL DEFAULT 'free',

    -- Settings stored as JSONB for flexibility
    settings JSONB NOT NULL DEFAULT '{
        "timezone": "UTC",
        "date_format": "YYYY-MM-DD",
        "default_issue_status": "backlog",
        "require_estimate": false,
        "auto_archive_days": 90
    }'::jsonb,

    -- Billing
    trial_ends_at TIMESTAMP WITH TIME ZONE,
    subscription_id VARCHAR(100),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9-]+$')
);

-- Indexes
CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_plan_type ON organizations(plan_type);
CREATE INDEX idx_organizations_created_at ON organizations(created_at);
```

### users

User accounts within organizations.

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Identity
    email VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    username VARCHAR(50),
    avatar_url TEXT,

    -- Authentication
    password_hash VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_admin BOOLEAN NOT NULL DEFAULT false,

    -- Profile
    timezone VARCHAR(50) DEFAULT 'UTC',
    preferences JSONB NOT NULL DEFAULT '{
        "theme": "system",
        "notifications_email": true,
        "notifications_web": true,
        "compact_view": false
    }'::jsonb,

    -- Timestamps
    last_login_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT users_email_org_unique UNIQUE (organization_id, email),
    CONSTRAINT users_username_org_unique UNIQUE (organization_id, username)
);

-- Indexes
CREATE INDEX idx_users_organization_id ON users(organization_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_is_active ON users(organization_id, is_active) WHERE is_active = true;
CREATE INDEX idx_users_last_login ON users(last_login_at DESC NULLS LAST);
```

### teams

Team groupings within organizations.

```sql
CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    name VARCHAR(100) NOT NULL,
    slug VARCHAR(50) NOT NULL,
    description TEXT,
    icon VARCHAR(50),
    color VARCHAR(7),  -- Hex color

    -- Settings
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT teams_slug_org_unique UNIQUE (organization_id, slug)
);

-- Indexes
CREATE INDEX idx_teams_organization_id ON teams(organization_id);
CREATE INDEX idx_teams_slug ON teams(organization_id, slug);
```

### team_members

Many-to-many relationship between users and teams.

```sql
CREATE TABLE team_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role team_role NOT NULL DEFAULT 'member',

    -- Timestamps
    joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT team_members_unique UNIQUE (team_id, user_id)
);

-- Indexes
CREATE INDEX idx_team_members_team_id ON team_members(team_id);
CREATE INDEX idx_team_members_user_id ON team_members(user_id);
CREATE INDEX idx_team_members_role ON team_members(team_id, role);
```

### projects

Containers for issues (like Linear workspaces or Jira projects).

```sql
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    lead_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Identity
    name VARCHAR(100) NOT NULL,
    key VARCHAR(10) NOT NULL,  -- e.g., "ENG", "PROD"
    description TEXT,
    icon VARCHAR(50),
    color VARCHAR(7),

    -- Status
    status project_status NOT NULL DEFAULT 'active',

    -- Settings
    settings JSONB NOT NULL DEFAULT '{
        "default_status": "backlog",
        "enable_cycles": true,
        "cycle_duration_weeks": 2,
        "enable_estimates": true
    }'::jsonb,

    -- Counters
    issue_count INTEGER NOT NULL DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMP WITH TIME ZONE,

    -- Constraints
    CONSTRAINT projects_key_org_unique UNIQUE (organization_id, key),
    CONSTRAINT projects_key_format CHECK (key ~ '^[A-Z]{2,10}$')
);

-- Indexes
CREATE INDEX idx_projects_organization_id ON projects(organization_id);
CREATE INDEX idx_projects_team_id ON projects(team_id);
CREATE INDEX idx_projects_status ON projects(organization_id, status);
CREATE INDEX idx_projects_key ON projects(organization_id, key);
```

### cycles

Sprint-like time periods for organizing work.

```sql
CREATE TABLE cycles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

    -- Identity
    name VARCHAR(100) NOT NULL,
    number INTEGER NOT NULL,
    description TEXT,

    -- Dates
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,

    -- Status
    status cycle_status NOT NULL DEFAULT 'upcoming',

    -- Progress
    completed_issue_count INTEGER NOT NULL DEFAULT 0,
    total_issue_count INTEGER NOT NULL DEFAULT 0,
    completed_estimate DECIMAL(10, 2) DEFAULT 0,
    total_estimate DECIMAL(10, 2) DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT cycles_number_project_unique UNIQUE (project_id, number),
    CONSTRAINT cycles_dates_valid CHECK (end_date > start_date)
);

-- Indexes
CREATE INDEX idx_cycles_project_id ON cycles(project_id);
CREATE INDEX idx_cycles_status ON cycles(project_id, status);
CREATE INDEX idx_cycles_dates ON cycles(start_date, end_date);
```

### labels

Labels for categorizing issues.

```sql
CREATE TABLE labels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

    -- Identity
    name VARCHAR(50) NOT NULL,
    description TEXT,
    color VARCHAR(7) NOT NULL,  -- Hex color

    -- Hierarchy (for future label groups)
    parent_id UUID REFERENCES labels(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT labels_name_project_unique UNIQUE (project_id, name)
);

-- Indexes
CREATE INDEX idx_labels_project_id ON labels(project_id);
CREATE INDEX idx_labels_parent_id ON labels(parent_id);
```

### issues

The core entity - work items tracked in the system.

```sql
CREATE TABLE issues (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Relationships
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cycle_id UUID REFERENCES cycles(id) ON DELETE SET NULL,
    parent_id UUID REFERENCES issues(id) ON DELETE SET NULL,  -- Sub-issues

    -- People
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Identity
    number INTEGER NOT NULL,  -- Auto-incrementing per project
    title VARCHAR(500) NOT NULL,
    description TEXT,

    -- Status & Priority
    status issue_status NOT NULL DEFAULT 'backlog',
    priority issue_priority NOT NULL DEFAULT 'none',

    -- Estimation
    estimate DECIMAL(5, 2),  -- Story points or hours

    -- Dates
    due_date DATE,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,

    -- Metadata (flexible fields for future features)
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Counters (denormalized for performance)
    comment_count INTEGER NOT NULL DEFAULT 0,
    attachment_count INTEGER NOT NULL DEFAULT 0,
    sub_issue_count INTEGER NOT NULL DEFAULT 0,

    -- Sorting
    sort_order DECIMAL(20, 10) NOT NULL DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMP WITH TIME ZONE,

    -- Constraints
    CONSTRAINT issues_number_project_unique UNIQUE (project_id, number)
);

-- Primary query indexes
CREATE INDEX idx_issues_project_id ON issues(project_id);
CREATE INDEX idx_issues_assignee_id ON issues(assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX idx_issues_creator_id ON issues(creator_id);
CREATE INDEX idx_issues_cycle_id ON issues(cycle_id) WHERE cycle_id IS NOT NULL;
CREATE INDEX idx_issues_parent_id ON issues(parent_id) WHERE parent_id IS NOT NULL;

-- Status and priority filtering (common queries)
CREATE INDEX idx_issues_status ON issues(project_id, status);
CREATE INDEX idx_issues_priority ON issues(project_id, priority);

-- Date-based queries
CREATE INDEX idx_issues_due_date ON issues(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_issues_created_at ON issues(project_id, created_at DESC);
CREATE INDEX idx_issues_updated_at ON issues(updated_at DESC);

-- Sorting
CREATE INDEX idx_issues_sort_order ON issues(project_id, sort_order);

-- Combined indexes for common filter patterns
CREATE INDEX idx_issues_project_status_assignee ON issues(project_id, status, assignee_id);

-- JSONB index for metadata queries
CREATE INDEX idx_issues_metadata ON issues USING gin(metadata);

-- Full-text search (will be enhanced in later migrations)
-- CREATE INDEX idx_issues_search ON issues USING gin(to_tsvector('english', title || ' ' || COALESCE(description, '')));
```

### issue_labels

Many-to-many relationship between issues and labels.

```sql
CREATE TABLE issue_labels (
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    PRIMARY KEY (issue_id, label_id)
);

-- Indexes
CREATE INDEX idx_issue_labels_issue_id ON issue_labels(issue_id);
CREATE INDEX idx_issue_labels_label_id ON issue_labels(label_id);
```

### issue_links

Relationships between issues (blocks, relates to, duplicates).

```sql
CREATE TABLE issue_links (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    target_issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    link_type link_type NOT NULL,

    created_by_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT issue_links_no_self_link CHECK (source_issue_id != target_issue_id),
    CONSTRAINT issue_links_unique UNIQUE (source_issue_id, target_issue_id, link_type)
);

-- Indexes
CREATE INDEX idx_issue_links_source ON issue_links(source_issue_id);
CREATE INDEX idx_issue_links_target ON issue_links(target_issue_id);
```

### comments

Comments on issues.

```sql
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    -- Parent comment for threading
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,

    -- Content
    body TEXT NOT NULL,
    body_html TEXT,  -- Rendered markdown

    -- Flags
    is_internal BOOLEAN NOT NULL DEFAULT false,  -- Internal team notes
    is_edited BOOLEAN NOT NULL DEFAULT false,

    -- Reactions stored as JSONB: {"👍": ["user_id1"], "❤️": ["user_id2"]}
    reactions JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_comments_issue_id ON comments(issue_id);
CREATE INDEX idx_comments_user_id ON comments(user_id);
CREATE INDEX idx_comments_parent_id ON comments(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_comments_created_at ON comments(issue_id, created_at DESC);
CREATE INDEX idx_comments_is_internal ON comments(issue_id, is_internal) WHERE is_internal = true;
```

### attachments

File attachments on issues.

```sql
CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,

    -- File info
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(100) NOT NULL,
    file_size BIGINT NOT NULL,

    -- Storage
    storage_key VARCHAR(500) NOT NULL,  -- S3 key or local path
    storage_provider VARCHAR(20) NOT NULL DEFAULT 'local',

    -- Image metadata
    width INTEGER,
    height INTEGER,
    thumbnail_key VARCHAR(500),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_attachments_issue_id ON attachments(issue_id);
CREATE INDEX idx_attachments_user_id ON attachments(user_id);
CREATE INDEX idx_attachments_comment_id ON attachments(comment_id) WHERE comment_id IS NOT NULL;
```

### activity_log

Audit trail for all changes (high-volume table).

```sql
CREATE TABLE activity_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Context
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    issue_id UUID REFERENCES issues(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Activity details
    action activity_action NOT NULL,
    entity_type VARCHAR(50) NOT NULL,  -- 'issue', 'comment', 'project', etc.
    entity_id UUID NOT NULL,

    -- Change details stored as JSONB
    -- Example: {"field": "status", "old": "todo", "new": "in_progress"}
    changes JSONB,

    -- Metadata
    ip_address INET,
    user_agent TEXT,

    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes (this is a high-volume table)
CREATE INDEX idx_activity_log_organization_id ON activity_log(organization_id);
CREATE INDEX idx_activity_log_project_id ON activity_log(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_activity_log_issue_id ON activity_log(issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX idx_activity_log_user_id ON activity_log(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_activity_log_created_at ON activity_log(organization_id, created_at DESC);
CREATE INDEX idx_activity_log_entity ON activity_log(entity_type, entity_id);
CREATE INDEX idx_activity_log_action ON activity_log(organization_id, action, created_at DESC);

-- Partial index for recent activity (last 30 days)
CREATE INDEX idx_activity_log_recent ON activity_log(organization_id, created_at DESC)
    WHERE created_at > NOW() - INTERVAL '30 days';
```

### notifications

User notifications.

```sql
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Notification content
    type notification_type NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT,

    -- Related entities
    issue_id UUID REFERENCES issues(id) ON DELETE CASCADE,
    comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- Who triggered it

    -- URL to navigate to
    url TEXT,

    -- Status
    read_at TIMESTAMP WITH TIME ZONE,
    archived_at TIMESTAMP WITH TIME ZONE,

    -- Delivery
    email_sent_at TIMESTAMP WITH TIME ZONE,

    -- Timestamp
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_issue_id ON notifications(issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX idx_notifications_created_at ON notifications(user_id, created_at DESC);
```

### webhooks

Outgoing webhook configurations.

```sql
CREATE TABLE webhooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Configuration
    name VARCHAR(100) NOT NULL,
    url TEXT NOT NULL,
    secret VARCHAR(255) NOT NULL,

    -- Events to trigger on (stored as array)
    events TEXT[] NOT NULL DEFAULT '{}',

    -- Status
    is_active BOOLEAN NOT NULL DEFAULT true,

    -- Statistics
    last_triggered_at TIMESTAMP WITH TIME ZONE,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_webhooks_organization_id ON webhooks(organization_id);
CREATE INDEX idx_webhooks_active ON webhooks(organization_id, is_active) WHERE is_active = true;
```

### api_tokens

API authentication tokens.

```sql
CREATE TABLE api_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Token info
    name VARCHAR(100) NOT NULL,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    token_prefix VARCHAR(10) NOT NULL,  -- First chars for identification

    -- Permissions
    scopes TEXT[] NOT NULL DEFAULT '{"read"}',

    -- Usage
    last_used_at TIMESTAMP WITH TIME ZONE,
    last_used_ip INET,

    -- Expiration
    expires_at TIMESTAMP WITH TIME ZONE,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMP WITH TIME ZONE
);

-- Indexes
CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);
CREATE INDEX idx_api_tokens_token_hash ON api_tokens(token_hash);
CREATE INDEX idx_api_tokens_active ON api_tokens(user_id, expires_at)
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW());
```

## Triggers

### Updated timestamps

```sql
-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply to relevant tables
CREATE TRIGGER update_organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_teams_updated_at
    BEFORE UPDATE ON teams
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_cycles_updated_at
    BEFORE UPDATE ON cycles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_issues_updated_at
    BEFORE UPDATE ON issues
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_comments_updated_at
    BEFORE UPDATE ON comments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_webhooks_updated_at
    BEFORE UPDATE ON webhooks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

### Issue number auto-increment

```sql
-- Function to auto-increment issue number per project
CREATE OR REPLACE FUNCTION set_issue_number()
RETURNS TRIGGER AS $$
BEGIN
    -- Get next number for this project
    SELECT COALESCE(MAX(number), 0) + 1 INTO NEW.number
    FROM issues
    WHERE project_id = NEW.project_id;

    -- Also increment project issue count
    UPDATE projects
    SET issue_count = issue_count + 1
    WHERE id = NEW.project_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_issue_number_trigger
    BEFORE INSERT ON issues
    FOR EACH ROW
    WHEN (NEW.number IS NULL)
    EXECUTE FUNCTION set_issue_number();
```

### Comment count update

```sql
-- Function to update comment count on issues
CREATE OR REPLACE FUNCTION update_issue_comment_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE issues SET comment_count = comment_count + 1 WHERE id = NEW.issue_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE issues SET comment_count = comment_count - 1 WHERE id = OLD.issue_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_comment_count_trigger
    AFTER INSERT OR DELETE ON comments
    FOR EACH ROW EXECUTE FUNCTION update_issue_comment_count();
```

## Views

### Active issues summary

```sql
CREATE VIEW v_active_issues AS
SELECT
    i.id,
    i.project_id,
    p.key AS project_key,
    i.number,
    CONCAT(p.key, '-', i.number) AS issue_key,
    i.title,
    i.status,
    i.priority,
    i.assignee_id,
    u.name AS assignee_name,
    i.due_date,
    i.estimate,
    i.comment_count,
    i.created_at,
    i.updated_at
FROM issues i
JOIN projects p ON p.id = i.project_id
LEFT JOIN users u ON u.id = i.assignee_id
WHERE i.archived_at IS NULL
    AND i.status NOT IN ('done', 'cancelled');
```

### Organization stats

```sql
CREATE VIEW v_organization_stats AS
SELECT
    o.id AS organization_id,
    o.name,
    COUNT(DISTINCT u.id) AS user_count,
    COUNT(DISTINCT p.id) AS project_count,
    COUNT(DISTINCT i.id) AS total_issues,
    COUNT(DISTINCT i.id) FILTER (WHERE i.status NOT IN ('done', 'cancelled')) AS open_issues,
    COUNT(DISTINCT c.id) AS total_comments
FROM organizations o
LEFT JOIN users u ON u.organization_id = o.id
LEFT JOIN projects p ON p.organization_id = o.id
LEFT JOIN issues i ON i.project_id = p.id
LEFT JOIN comments c ON c.issue_id = i.id
GROUP BY o.id, o.name;
```

## Data Size Estimates

| Table | Row Count (Initial) | Avg Row Size | Total Size |
|-------|---------------------|--------------|------------|
| organizations | 100 | 500 B | 50 KB |
| users | 5,000 | 800 B | 4 MB |
| teams | 500 | 500 B | 250 KB |
| team_members | 3,000 | 100 B | 300 KB |
| projects | 1,000 | 1 KB | 1 MB |
| cycles | 2,000 | 500 B | 1 MB |
| labels | 5,000 | 200 B | 1 MB |
| issues | 500,000 | 2 KB | 1 GB |
| issue_labels | 1,000,000 | 50 B | 50 MB |
| issue_links | 50,000 | 100 B | 5 MB |
| comments | 2,000,000 | 1 KB | 2 GB |
| attachments | 50,000 | 500 B | 25 MB |
| activity_log | 3,000,000 | 500 B | 1.5 GB |
| notifications | 500,000 | 300 B | 150 MB |
| webhooks | 500 | 500 B | 250 KB |
| api_tokens | 2,000 | 300 B | 600 KB |
| **Indexes** | - | - | ~3 GB |
| **TOAST/Overhead** | - | - | ~1 GB |
| **Total** | - | - | **~10 GB** |

## Maintenance Considerations

### High-Update Tables (Bloat Risk)

1. **issues** - Status changes, assignments
2. **notifications** - Mark as read
3. **cycles** - Progress updates

### High-Insert Tables (Growth)

1. **activity_log** - Every action logged
2. **comments** - User engagement
3. **notifications** - Generated frequently

### Partitioning Candidates

1. **activity_log** - By month (range partition on created_at)
2. **notifications** - By month

### Archive Candidates

1. **Completed issues** > 1 year old
2. **Read notifications** > 30 days old
3. **Activity logs** > 1 year old
