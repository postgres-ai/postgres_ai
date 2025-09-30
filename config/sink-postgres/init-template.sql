-- Initialize Postgres sink database for storing pgwatch measurements
-- This database will store all the monitoring metrics collected by pgwatch
-- Based on https://pgwat.ch/latest/howto/metrics_db_bootstrap.html

-- Create the pgwatch role for measurements database
create role ${PGWATCH_MONITOR_USER} with login password '${PGWATCH_MONITOR_PASSWORD}';

-- Create the measurements database owned by pgwatch
create database measurements owner ${PGWATCH_MONITOR_USER};

-- Switch to the measurements database context
\c measurements;

-- Create extensions that might be useful for metrics storage
create extension if not exists btree_gist;
create extension if not exists pg_stat_statements;

-- Grant necessary permissions to pgwatch user
grant all privileges on database measurements to ${PGWATCH_MONITOR_USER};
grant all privileges on schema public to ${PGWATCH_MONITOR_USER};

-- Create a partitioned table for queryid-to-query mappings with list partitioning by dbname
create table if not exists public.pgss_queryid_queries (
  time timestamptz not null,
  dbname text not null,
  data jsonb not null,
  tag_data jsonb
) partition by list (dbname);

-- Create indexes for efficient lookups
create index if not exists pgss_queryid_queries_dbname_time_idx
  on public.pgss_queryid_queries (dbname, time);

-- Set ownership and grant permissions to pgwatch
alter table public.pgss_queryid_queries owner to ${PGWATCH_MONITOR_USER};
grant all privileges on table public.pgss_queryid_queries to ${PGWATCH_MONITOR_USER};

-- Ensure pgwatch can use sequences (if any are created)
grant usage on schema public to ${PGWATCH_MONITOR_USER};

-- Grant permissions on all future tables in public schema
alter default privileges in schema public grant all on tables to ${PGWATCH_MONITOR_USER};

create or replace function enforce_queryid_uniqueness()
returns trigger as $$
declare
  queryid_value text;
begin
  -- Extract queryid from the data jsonb
  queryid_value := new.data->>'queryid';

  -- Allow null queryids through
  if queryid_value is null then
    return new;
  end if;

  -- Silently skip if duplicate exists
  if exists (
    select 1
    from pgss_queryid_queries
    where
      dbname = new.dbname
      and data->>'queryid' = queryid_value
    limit 1
  ) then
    return null;  -- Cancels insert silently
  end if;

  return new;
end;
$$ language plpgsql;

create or replace trigger enforce_queryid_uniqueness_trigger
  before insert on pgss_queryid_queries
  for each row
  execute function enforce_queryid_uniqueness();