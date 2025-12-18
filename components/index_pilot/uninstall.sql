-- pg_index_pilot Uninstall Script
-- This script completely removes pg_index_pilot from your database
-- WARNING: This will delete all collected statistics and history!

-- 1. Drop all FDW servers registered in index_pilot.target_databases
do $$
declare r record;
begin
  for r in select distinct fdw_server_name from index_pilot.target_databases loop
    begin
      execute format('drop server if exists %I cascade', r.fdw_server_name);
    exception when others then
      perform 1;
    end;
  end loop;
exception when undefined_table then
  perform 1;
end $$;

-- 2. Drop the schema cascade (this removes all objects)
drop schema if exists index_pilot cascade;

-- 3. Note about invalid indexes
-- Invalid _ccnew* indexes might exist from failed reindex operations
-- These could be from pg_index_pilot or from manual operations
-- To list them (but NOT automatically drop):
do $$
declare
  r record;
  count int := 0;
begin
  for r in 
    select n.nspname, i.relname 
    from pg_index idx
    join pg_class i on i.oid = idx.indexrelid
    join pg_namespace n on n.oid = i.relnamespace
    where i.relname ~ '_ccnew[0-9]*$'
      and not idx.indisvalid
  loop
    count := count + 1;
    raise notice 'Found invalid index (review before dropping): %.%', r.nspname, r.relname;
  end loop;

  if count > 0 then
    raise notice '---';
    raise notice 'Found % invalid _ccnew indexes. Review and drop manually if needed.', count;
    raise notice 'To drop: DROP INDEX CONCURRENTLY IF EXISTS schema.index_name;';
  end if;
end $$;

-- Note: postgres_fdw extension is not removed as it may be used by other applications
-- If you want to remove it and it's not used elsewhere, run:
-- drop extension postgres_fdw cascade;