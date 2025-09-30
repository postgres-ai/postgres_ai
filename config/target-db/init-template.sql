-- Initialize target database for monitoring
-- Enable pg_stat_statements extension for query monitoring
create extension if not exists pg_stat_statements;

-- Create a sample table for demonstration
create table if not exists sample_data (
  id serial primary key,
  name varchar(100),
  created_at timestamp default current_timestamp
);

-- Insert some sample data
insert into sample_data (name)
values
  ('Sample Record 1'),
  ('Sample Record 2'),
  ('Sample Record 3');

-- Create a user for pgwatch monitoring
create user ${TARGET_MONITOR_USER} with password '${TARGET_MONITOR_PASSWORD}';
grant connect on database target_database to ${TARGET_MONITOR_USER};
grant usage on schema public to ${TARGET_MONITOR_USER};

-- Create a public view for pg_statistic access
create or replace view public.pg_statistic as
select
  n.nspname as schemaname,
  c.relname as tablename,
  a.attname,
  s.stanullfrac as null_frac,
  s.stawidth as avg_width,
  false as inherited
from pg_statistic as s
join pg_class as c on c.oid = s.starelid
join pg_namespace as n on n.oid = c.relnamespace
join pg_attribute as a on a.attrelid = s.starelid and a.attnum = s.staattnum
where
  a.attnum > 0
  and not a.attisdropped;

-- Grant specific access instead of all tables
grant select on public.pg_statistic to pg_monitor;

-- Grant access to monitoring views
grant select on pg_stat_statements to ${TARGET_MONITOR_USER};
grant select on pg_stat_database to ${TARGET_MONITOR_USER};
grant select on pg_stat_user_tables to ${TARGET_MONITOR_USER};

-- Grant pg_monitor role to monitor user for enhanced monitoring capabilities
grant pg_monitor to ${TARGET_MONITOR_USER};

-- Set search path for the monitor user
alter user ${TARGET_MONITOR_USER} set search_path = "$user", public, pg_catalog;