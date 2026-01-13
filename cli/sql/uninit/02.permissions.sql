-- Revoke permissions and drop objects created by prepare-db (template-filled by cli/lib/init.ts)

-- Drop the postgres_ai.pg_statistic view
drop view if exists postgres_ai.pg_statistic;

-- Drop the postgres_ai schema (CASCADE to handle any remaining objects)
drop schema if exists postgres_ai cascade;

-- Revoke permissions from the monitoring role
-- Use a DO block to handle the case where the role doesn't exist
do $$ begin
  revoke pg_monitor from {{ROLE_IDENT}};
exception when undefined_object then
  null; -- Role doesn't exist, nothing to revoke
end $$;

do $$ begin
  revoke select on pg_catalog.pg_index from {{ROLE_IDENT}};
exception when undefined_object then
  null; -- Role doesn't exist
end $$;

do $$ begin
  revoke connect on database {{DB_IDENT}} from {{ROLE_IDENT}};
exception when undefined_object then
  null; -- Role doesn't exist
end $$;

-- Note: USAGE on public is typically granted by default; we don't revoke it
-- to avoid breaking other applications that may rely on it.
