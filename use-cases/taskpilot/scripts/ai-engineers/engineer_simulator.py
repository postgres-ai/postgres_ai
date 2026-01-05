#!/usr/bin/env python3
"""
AI Engineer Simulator for TaskPilot

Simulates a team of engineers making schema changes according to the roadmap.
This creates realistic database migration patterns for testing postgres_ai.

Usage:
    python scripts/ai-engineers/engineer_simulator.py

Environment:
    DATABASE_URL: PostgreSQL connection string
    ENGINEER_CHANGES_PER_DAY: Number of changes per day (default: 2)
    ENGINEER_ERROR_RATE: Probability of problematic changes (default: 0.2)
"""

import os
import sys
import random
import time
from datetime import datetime, timedelta
from dataclasses import dataclass
from typing import Optional, Callable
from enum import Enum

try:
    import psycopg
    from psycopg import sql
except ImportError:
    print("Installing psycopg...")
    os.system("pip install psycopg[binary]")
    import psycopg
    from psycopg import sql


# Configuration
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://taskpilot:taskpilot@localhost:5433/taskpilot"
)
CHANGES_PER_DAY = int(os.getenv("ENGINEER_CHANGES_PER_DAY", "2"))
ERROR_RATE = float(os.getenv("ENGINEER_ERROR_RATE", "0.2"))


class ChangeQuality(Enum):
    """Quality of the schema change."""
    GOOD = "good"
    SUBOPTIMAL = "suboptimal"
    PROBLEMATIC = "problematic"


@dataclass
class Engineer:
    """Simulated engineer with specific characteristics."""
    name: str
    experience_years: int
    error_rate: float
    focus: str

    def decide_quality(self) -> ChangeQuality:
        """Decide the quality of the next change based on experience."""
        rand = random.random()
        if rand < self.error_rate * 0.5:
            return ChangeQuality.PROBLEMATIC
        elif rand < self.error_rate:
            return ChangeQuality.SUBOPTIMAL
        return ChangeQuality.GOOD


@dataclass
class SchemaChange:
    """A schema change to be applied."""
    name: str
    description: str
    sql_good: str
    sql_suboptimal: Optional[str] = None
    sql_problematic: Optional[str] = None
    week: int = 1
    day: int = 1
    engineer: str = "Alex"
    postgres_ai_finding: Optional[str] = None


# Engineer profiles
ENGINEERS = [
    Engineer(
        name="Alex",
        experience_years=8,
        error_rate=0.1,
        focus="Core features"
    ),
    Engineer(
        name="Sam",
        experience_years=4,
        error_rate=0.25,
        focus="Full-stack"
    ),
    Engineer(
        name="Jordan",
        experience_years=1,
        error_rate=0.4,
        focus="Bug fixes"
    ),
]


# Schema changes roadmap
SCHEMA_CHANGES = [
    # Week 1: Time Tracking
    SchemaChange(
        name="add_time_tracking_columns",
        description="Add time tracking columns to issues",
        sql_good="""
            ALTER TABLE issues ADD COLUMN IF NOT EXISTS time_estimate_minutes INTEGER;
            ALTER TABLE issues ADD COLUMN IF NOT EXISTS time_spent_minutes INTEGER DEFAULT 0;
        """,
        week=1, day=1, engineer="Alex"
    ),
    SchemaChange(
        name="create_time_entries_table",
        description="Create time entries table",
        sql_good="""
            CREATE TABLE IF NOT EXISTS time_entries (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                minutes INTEGER NOT NULL,
                description TEXT,
                date DATE NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_time_entries_issue_id ON time_entries(issue_id);
        """,
        sql_suboptimal="""
            CREATE TABLE IF NOT EXISTS time_entries (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
                minutes INTEGER NOT NULL,
                description TEXT,
                date DATE NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
            -- Missing index on issue_id!
        """,
        postgres_ai_finding="Missing FK index on time_entries.issue_id",
        week=1, day=2, engineer="Sam"
    ),

    # Week 2: Custom Fields
    SchemaChange(
        name="add_custom_fields_jsonb",
        description="Add JSONB column for custom fields",
        sql_good="""
            ALTER TABLE issues ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'::jsonb;
            CREATE INDEX IF NOT EXISTS idx_issues_custom_fields ON issues USING gin(custom_fields);
        """,
        week=2, day=1, engineer="Alex"
    ),
    SchemaChange(
        name="create_custom_field_definitions",
        description="Create custom field definitions table",
        sql_good="""
            CREATE TABLE IF NOT EXISTS custom_field_definitions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name VARCHAR(50) NOT NULL,
                field_type VARCHAR(20) NOT NULL,
                options JSONB,
                is_required BOOLEAN DEFAULT false,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                CONSTRAINT custom_field_def_unique UNIQUE (project_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_custom_field_def_project ON custom_field_definitions(project_id);
        """,
        sql_suboptimal="""
            CREATE TABLE IF NOT EXISTS custom_field_definitions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name VARCHAR(50) NOT NULL,
                field_type VARCHAR(20) NOT NULL,
                options JSONB,
                is_required BOOLEAN DEFAULT false,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                CONSTRAINT custom_field_def_unique UNIQUE (project_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_custom_field_def_project ON custom_field_definitions(project_id);
            CREATE INDEX IF NOT EXISTS idx_custom_field_def_name ON custom_field_definitions(name);
            -- Redundant index!
        """,
        postgres_ai_finding="H004 Redundant index on custom_field_definitions.name",
        week=2, day=2, engineer="Sam"
    ),

    # Week 3: Full-Text Search
    SchemaChange(
        name="add_search_vector",
        description="Add tsvector column for full-text search",
        sql_good="""
            ALTER TABLE issues ADD COLUMN IF NOT EXISTS search_vector tsvector;
            CREATE INDEX IF NOT EXISTS idx_issues_search_vector ON issues USING gin(search_vector);

            CREATE OR REPLACE FUNCTION issues_search_trigger()
            RETURNS trigger AS $$
            BEGIN
                NEW.search_vector :=
                    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
                    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B');
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS tsvector_update_trigger ON issues;
            CREATE TRIGGER tsvector_update_trigger
            BEFORE INSERT OR UPDATE OF title, description ON issues
            FOR EACH ROW EXECUTE FUNCTION issues_search_trigger();
        """,
        week=3, day=1, engineer="Alex"
    ),
    SchemaChange(
        name="add_trigram_indexes",
        description="Add trigram indexes for fuzzy search",
        sql_good="""
            CREATE INDEX IF NOT EXISTS idx_issues_title_trgm ON issues USING gin(title gin_trgm_ops);
        """,
        sql_suboptimal="""
            -- Adding both title and description trigram (might be overkill)
            CREATE INDEX IF NOT EXISTS idx_issues_title_trgm ON issues USING gin(title gin_trgm_ops);
            CREATE INDEX IF NOT EXISTS idx_issues_desc_trgm ON issues USING gin(description gin_trgm_ops);
        """,
        postgres_ai_finding="Consider if both FTS and trigram indexes are needed",
        week=3, day=2, engineer="Sam"
    ),

    # Week 4: SLA Tracking
    SchemaChange(
        name="create_sla_tables",
        description="Create SLA policies and status tables",
        sql_good="""
            CREATE TABLE IF NOT EXISTS sla_policies (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                name VARCHAR(100) NOT NULL,
                description TEXT,
                conditions JSONB NOT NULL,
                targets JSONB NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_sla_policies_org ON sla_policies(organization_id);

            CREATE TABLE IF NOT EXISTS sla_status (
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
            CREATE INDEX IF NOT EXISTS idx_sla_status_issue ON sla_status(issue_id);
        """,
        sql_suboptimal="""
            CREATE TABLE IF NOT EXISTS sla_policies (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                name VARCHAR(100) NOT NULL,
                description TEXT,
                conditions JSONB NOT NULL,
                targets JSONB NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
            -- Missing index on organization_id!

            CREATE TABLE IF NOT EXISTS sla_status (
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
            -- Missing index on issue_id!
        """,
        postgres_ai_finding="Missing FK indexes on sla_policies and sla_status",
        week=4, day=1, engineer="Sam"
    ),

    # Week 5: API Rate Limiting
    SchemaChange(
        name="create_api_rate_limiting",
        description="Create API rate limiting tables",
        sql_good="""
            CREATE TABLE IF NOT EXISTS api_rate_limits (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                endpoint_pattern VARCHAR(200) NOT NULL,
                requests_per_minute INTEGER NOT NULL DEFAULT 100,
                requests_per_hour INTEGER NOT NULL DEFAULT 1000,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS api_request_log (
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
            CREATE INDEX IF NOT EXISTS idx_api_request_log_org_time
                ON api_request_log(organization_id, created_at DESC);
        """,
        week=5, day=1, engineer="Alex"
    ),

    # Week 6: Issue Templates
    SchemaChange(
        name="create_issue_templates",
        description="Create issue templates table",
        sql_good="""
            CREATE TABLE IF NOT EXISTS issue_templates (
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
            CREATE INDEX IF NOT EXISTS idx_issue_templates_project ON issue_templates(project_id);
        """,
        week=6, day=1, engineer="Sam"
    ),
    SchemaChange(
        name="add_template_id_to_issues",
        description="Add template_id column to issues",
        sql_good="""
            ALTER TABLE issues ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES issue_templates(id);
            CREATE INDEX IF NOT EXISTS idx_issues_template ON issues(template_id)
                WHERE template_id IS NOT NULL;
        """,
        sql_suboptimal="""
            ALTER TABLE issues ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES issue_templates(id);
            -- Missing index on template_id!
        """,
        postgres_ai_finding="Missing index on issues.template_id",
        week=6, day=2, engineer="Jordan"
    ),

    # Week 7: Recurring Issues
    SchemaChange(
        name="create_recurring_issues",
        description="Create recurring issue configuration table",
        sql_good="""
            CREATE TABLE IF NOT EXISTS recurring_issue_configs (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                template_id UUID REFERENCES issue_templates(id) ON DELETE SET NULL,
                created_by UUID NOT NULL REFERENCES users(id),
                schedule_type VARCHAR(20) NOT NULL,
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
            CREATE INDEX IF NOT EXISTS idx_recurring_configs_project ON recurring_issue_configs(project_id);
            CREATE INDEX IF NOT EXISTS idx_recurring_configs_next_run ON recurring_issue_configs(next_run_at)
                WHERE is_active = true;
        """,
        week=7, day=1, engineer="Alex"
    ),

    # Week 8: Automation Rules
    SchemaChange(
        name="create_automation_rules",
        description="Create automation rules table",
        sql_good="""
            CREATE TABLE IF NOT EXISTS automation_rules (
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
            CREATE INDEX IF NOT EXISTS idx_automation_rules_project ON automation_rules(project_id);
            CREATE INDEX IF NOT EXISTS idx_automation_rules_active
                ON automation_rules(project_id, is_active, priority) WHERE is_active = true;
        """,
        week=8, day=1, engineer="Alex"
    ),

    # Week 9: Analytics Tables
    SchemaChange(
        name="create_project_metrics",
        description="Create project daily metrics table",
        sql_good="""
            CREATE TABLE IF NOT EXISTS project_daily_metrics (
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
            CREATE INDEX IF NOT EXISTS idx_project_metrics_project_date
                ON project_daily_metrics(project_id, date DESC);
        """,
        week=9, day=1, engineer="Alex"
    ),

    # Week 10: External Integrations
    SchemaChange(
        name="create_external_integrations",
        description="Create external integrations tables",
        sql_good="""
            CREATE TABLE IF NOT EXISTS external_integrations (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                organization_id UUID NOT NULL REFERENCES organizations(id),
                provider VARCHAR(50) NOT NULL,
                config JSONB NOT NULL,
                status VARCHAR(20) DEFAULT 'active',
                last_sync_at TIMESTAMP WITH TIME ZONE,
                sync_error TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_external_integrations_org ON external_integrations(organization_id);

            CREATE TABLE IF NOT EXISTS issue_external_links (
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
            CREATE INDEX IF NOT EXISTS idx_issue_external_links_issue ON issue_external_links(issue_id);
        """,
        week=10, day=1, engineer="Sam"
    ),
]


class EngineerSimulator:
    """Simulates AI engineers making schema changes."""

    def __init__(self, database_url: str):
        self.database_url = database_url
        self.changes_applied = 0
        self.current_week = 1
        self.current_day = 1

    def connect(self):
        """Create database connection."""
        return psycopg.connect(self.database_url)

    def apply_change(self, change: SchemaChange, quality: ChangeQuality) -> bool:
        """Apply a schema change with the given quality level."""
        sql_to_run = change.sql_good

        if quality == ChangeQuality.SUBOPTIMAL and change.sql_suboptimal:
            sql_to_run = change.sql_suboptimal
            print(f"  ⚠️  SUBOPTIMAL change (postgres_ai should detect: {change.postgres_ai_finding})")
        elif quality == ChangeQuality.PROBLEMATIC and change.sql_problematic:
            sql_to_run = change.sql_problematic
            print(f"  ❌ PROBLEMATIC change (postgres_ai should detect: {change.postgres_ai_finding})")

        try:
            with self.connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql_to_run)
                conn.commit()
            return True
        except Exception as e:
            print(f"  Error applying change: {e}")
            return False

    def get_next_changes(self, count: int = 1) -> list[SchemaChange]:
        """Get the next changes to apply based on current week/day."""
        applicable = [
            c for c in SCHEMA_CHANGES
            if c.week == self.current_week and c.day >= self.current_day
        ]
        return applicable[:count]

    def simulate_day(self):
        """Simulate a day of engineering work."""
        changes = self.get_next_changes(random.randint(1, 3))

        for change in changes:
            # Find the engineer
            engineer = next((e for e in ENGINEERS if e.name == change.engineer), ENGINEERS[0])
            quality = engineer.decide_quality()

            print(f"\n[Week {change.week}, Day {change.day}] {engineer.name} ({engineer.experience_years}yr exp)")
            print(f"  📝 {change.name}: {change.description}")

            if self.apply_change(change, quality):
                print(f"  ✅ Applied successfully")
                self.changes_applied += 1
            else:
                print(f"  ❌ Failed to apply")

        # Advance time
        self.current_day += 1
        if self.current_day > 5:  # 5 working days per week
            self.current_day = 1
            self.current_week += 1

    def run(self, duration_days: int = 60):
        """Run the simulation for the specified number of days."""
        print("=" * 60)
        print("TaskPilot AI Engineer Simulator")
        print("=" * 60)
        print(f"Database: {self.database_url.split('@')[1] if '@' in self.database_url else 'local'}")
        print(f"Duration: {duration_days} simulated days")
        print(f"Changes per day: {CHANGES_PER_DAY}")
        print(f"Error rate: {ERROR_RATE * 100}%")
        print()

        for day in range(duration_days):
            if self.current_week > 12:  # End of roadmap
                print("\n🎉 Roadmap complete!")
                break

            self.simulate_day()

            # Sleep between simulated days (in real usage, this would be longer)
            time.sleep(1)

        print(f"\n📊 Summary: Applied {self.changes_applied} changes over {self.current_week} weeks")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Simulate AI engineers making schema changes")
    parser.add_argument("--days", type=int, default=60, help="Number of days to simulate")
    parser.add_argument("--continuous", action="store_true", help="Run continuously (1 change per hour)")

    args = parser.parse_args()

    simulator = EngineerSimulator(DATABASE_URL)

    if args.continuous:
        print("Running in continuous mode (1 change per hour)...")
        while True:
            simulator.simulate_day()
            time.sleep(3600)  # 1 hour
    else:
        simulator.run(args.days)


if __name__ == "__main__":
    main()
