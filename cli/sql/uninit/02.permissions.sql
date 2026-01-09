-- Revoke permissions and drop objects created by prepare-db (template-filled by cli/lib/init.ts)

-- Drop the postgres_ai.pg_statistic view
drop view if exists postgres_ai.pg_statistic;

-- Drop the postgres_ai schema (CASCADE to handle any remaining objects)
drop schema if exists postgres_ai cascade;

-- Revoke permissions from the monitoring role
revoke pg_monitor from {{ROLE_IDENT}};
revoke select on pg_catalog.pg_index from {{ROLE_IDENT}};
revoke connect on database {{DB_IDENT}} from {{ROLE_IDENT}};

-- Note: USAGE on public is typically granted by default; we don't revoke it
-- to avoid breaking other applications that may rely on it.
