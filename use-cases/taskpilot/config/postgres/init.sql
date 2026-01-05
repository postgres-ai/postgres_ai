-- TaskPilot Database Initialization
-- This script runs on first container start

-- =============================================================================
-- Extensions
-- =============================================================================

-- Performance monitoring (required for postgres_ai)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Full-text search optimization
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN indexes for arrays and JSONB
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- Custom Types (Enums)
-- =============================================================================

-- Organization billing plans
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_type') THEN
        CREATE TYPE plan_type AS ENUM ('free', 'starter', 'pro', 'enterprise');
    END IF;
END$$;

-- Issue workflow status
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'issue_status') THEN
        CREATE TYPE issue_status AS ENUM (
            'backlog',
            'todo',
            'in_progress',
            'in_review',
            'done',
            'cancelled'
        );
    END IF;
END$$;

-- Issue priority levels
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'issue_priority') THEN
        CREATE TYPE issue_priority AS ENUM ('none', 'low', 'medium', 'high', 'urgent');
    END IF;
END$$;

-- Project status
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_status') THEN
        CREATE TYPE project_status AS ENUM ('active', 'paused', 'archived');
    END IF;
END$$;

-- Team member roles
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'team_role') THEN
        CREATE TYPE team_role AS ENUM ('member', 'lead', 'admin');
    END IF;
END$$;

-- Cycle status
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cycle_status') THEN
        CREATE TYPE cycle_status AS ENUM ('upcoming', 'active', 'completed');
    END IF;
END$$;

-- Issue link types
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_type') THEN
        CREATE TYPE link_type AS ENUM ('blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicate_of');
    END IF;
END$$;

-- Activity action types
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'activity_action') THEN
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
    END IF;
END$$;

-- Notification types
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_type') THEN
        CREATE TYPE notification_type AS ENUM (
            'issue_assigned',
            'issue_mentioned',
            'comment_added',
            'issue_updated',
            'due_date_reminder',
            'cycle_started',
            'cycle_ending'
        );
    END IF;
END$$;

-- =============================================================================
-- Helper Functions
-- =============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- =============================================================================
-- Grant permissions for monitoring
-- =============================================================================

-- Create a read-only monitoring role (for postgres_ai)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'monitoring') THEN
        CREATE ROLE monitoring WITH LOGIN PASSWORD 'monitoring123';
    END IF;
END$$;

-- Grant necessary permissions
GRANT CONNECT ON DATABASE taskpilot TO monitoring;
GRANT USAGE ON SCHEMA public TO monitoring;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO monitoring;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO monitoring;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO monitoring;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO monitoring;

-- Grant access to pg_stat_statements
GRANT pg_read_all_stats TO monitoring;

-- =============================================================================
-- Verify Setup
-- =============================================================================

DO $$
BEGIN
    RAISE NOTICE 'TaskPilot database initialization complete!';
    RAISE NOTICE 'Extensions installed: pg_stat_statements, pg_trgm, btree_gin, uuid-ossp';
    RAISE NOTICE 'Custom types created: plan_type, issue_status, issue_priority, etc.';
    RAISE NOTICE 'Monitoring role created: monitoring';
END$$;
