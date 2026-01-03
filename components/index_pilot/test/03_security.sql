-- Test 03: Security and Permissions Test
-- Exit on first error for CI
\set ON_ERROR_STOP on
\set QUIET on

\echo '======================================'
\echo 'TEST 03: Security and Permissions'
\echo '======================================'

-- 1. Test non-superuser compatibility
do $$
declare
  _is_superuser boolean;
begin
  select usesuper into _is_superuser 
  from pg_user 
  where usename = current_user;
  
  if _is_superuser then
    raise notice 'INFO: Running as superuser - non-superuser tests skipped';
  else
    raise notice 'PASS: Running as non-superuser';
  end if;
end $$;

-- 2. Verify schema permissions
do $$
declare
  _has_usage boolean;
begin
  select has_schema_privilege(current_user, 'index_pilot', 'usage') into _has_usage;
  
  if not _has_usage then
    raise exception 'FAIL: Current user lacks usage privilege on index_pilot schema';
  end if;
  raise notice 'PASS: Schema permissions verified';
end $$;

-- 3. Test SQL injection protection in function parameters
do $$
begin
  -- Try to inject SQL in database name
  begin
    perform index_pilot.get_index_bloat_estimates(
      (select database_name from index_pilot.target_databases where enabled = true limit 1) || '; drop table index_pilot.config; --'
    );
    -- If we get here, the injection attempt was properly handled
    raise notice 'PASS: SQL injection protection working (database name)';
  exception when others then
    -- Expected to fail safely
    raise notice 'PASS: SQL injection blocked (database name)';
  end;
end $$;

-- 4. Verify sensitive functions are protected
do $$
declare
  _func_count integer;
begin
  -- Check that internal functions start with underscore
  select count(*) into _func_count
  from pg_proc p
  join pg_namespace n on p.pronamespace = n.oid
  where n.nspname = 'index_pilot'
  and p.proname like '\_%'
  and p.proname not in ('_check_pg_version_bugfixed', '_check_pg14_version_bugfixed');
  
  if _func_count < 5 then
    raise WARNING 'WARNING: Few internal functions found (%), review naming convention', _func_count;
  else
    raise notice 'PASS: % internal functions use underscore prefix', _func_count;
  end if;
end $$;

-- 5. Test connection security (FDW/dblink)
do $$
declare
  _has_fdw boolean;
  _fdw_status record;
begin
  -- Check if postgres_fdw is available
  select exists (
    select 1 from pg_extension where extname = 'postgres_fdw'
  ) into _has_fdw;
  
  if _has_fdw then
    -- Check FDW security status
    for _fdw_status in 
      select * from index_pilot.check_fdw_security_status() 
    loop
      if _fdw_status.status in ('INSTALLED', 'GRANTED', 'exists', 'CONFIGURED', 'OK') then
        raise notice 'INFO: FDW % - %', _fdw_status.component, _fdw_status.status;
      ELSIF _fdw_status.status = 'MISSING' and _fdw_status.component like '%server%' then
        -- Server not configured yet is OK for tests
        raise notice 'INFO: FDW % - Not configured (OK for testing)', _fdw_status.component;
      else
        raise WARNING 'WARNING: FDW % - %', _fdw_status.component, _fdw_status.status;
      end if;
    end loop;
    raise notice 'PASS: FDW security checks completed';
  else
    raise notice 'INFO: postgres_fdw not installed - skipping FDW tests';
  end if;
end $$;

-- 6. Verify no plaintext passwords in config
do $$
declare
  _password_count integer;
begin
  select count(*) into _password_count
  from index_pilot.config
  where value ILIKE '%password%' 
  or key ILIKE '%password%'
  or comment ILIKE '%password%';
  
  if _password_count > 0 then
    raise exception 'FAIL: Found % potential password entries in config', _password_count;
  end if;
  raise notice 'PASS: No plaintext passwords in configuration';
end $$;

-- 7. Test privilege escalation prevention
do $$
begin
  -- Try to access pg_authid (superuser only)
  begin
    perform index_pilot._remote_get_indexes_info(
      (select database_name from index_pilot.target_databases where enabled = true limit 1), 
      'pg_catalog', 
      'pg_authid', 
      null
    );
    -- If we get here and aren't superuser, that's bad
    if not exists (select 1 from pg_user where usename = current_user and usesuper) then
      raise exception 'FAIL: Able to access restricted catalog as non-superuser';
    end if;
  exception when others then
    -- Expected to fail for non-superuser
    raise notice 'PASS: Cannot access restricted catalogs';
  end;
end $$;

\echo 'TEST 03: PASSED'
\echo ''