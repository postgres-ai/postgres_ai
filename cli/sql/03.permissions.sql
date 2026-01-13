-- Required permissions for postgres_ai monitoring user (template-filled by cli/lib/init.ts)

-- Allow connect
grant connect on database {{DB_IDENT}} to {{ROLE_IDENT}};

-- Standard monitoring privileges
grant pg_monitor to {{ROLE_IDENT}};
grant select on pg_catalog.pg_index to {{ROLE_IDENT}};

-- Create postgres_ai schema for our objects
-- Using IF NOT EXISTS for idempotency - prepare-db can be run multiple times
create schema if not exists postgres_ai;
grant usage on schema postgres_ai to {{ROLE_IDENT}};

-- For bloat analysis: expose pg_statistic via a view
create or replace view postgres_ai.pg_statistic as
select
    n.nspname as schemaname,
    c.relname as tablename,
    a.attname,
    s.stanullfrac as null_frac,
    s.stawidth as avg_width,
    false as inherited
from pg_catalog.pg_statistic s
join pg_catalog.pg_class c on c.oid = s.starelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_attribute a on a.attrelid = s.starelid and a.attnum = s.staattnum
where a.attnum > 0 and not a.attisdropped;

grant select on postgres_ai.pg_statistic to {{ROLE_IDENT}};

-- Hardened clusters sometimes revoke PUBLIC on schema public
grant usage on schema public to {{ROLE_IDENT}};

-- Keep search_path predictable; postgres_ai first so our objects are found
alter user {{ROLE_IDENT}} set search_path = postgres_ai, "$user", public, pg_catalog;


