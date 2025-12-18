begin;

-- Turn off useless (in this particular case) NOTICE noise
set client_min_messages to warning;

-- FDW and connection management functions for pg_index_pilot
-- This file contains all functions related to Foreign Data Wrapper (FDW) setup,
-- secure database connections, and connection management.

/*
 * Establish secure dblink connection to target database via postgres_fdw
 * Uses FDW user mapping for secure credentials, prevents deadlocks, auto-reconnects
 */
create function index_pilot._connect_securely(
  _datname name
) returns void as
$body$
begin
  -- CRITICAL: Prevent deadlocks - never allow reindex in the same database
  -- Control database architecture is REQUIRED
  if _datname = current_database() then
    raise exception using
      message = format(
        'Cannot connect to current database %s - this causes deadlocks.',
        _datname
      ),
      hint = 'pg_index_pilot must be run from separate control database.';
  end if;

  -- Disconnect existing connection if any
  if _datname = any(dblink_get_connections()) then
    perform dblink_disconnect(_datname);
  end if;
    
  -- Use ONLY postgres_fdw with user mapping (secure approach)
  -- Password is stored securely in PostgreSQL catalog, not in plain text
  declare
    _fdw_server_name text;
  begin
    -- Control database architecture is REQUIRED - get the FDW server for the target database
    select fdw_server_name
    into _fdw_server_name
    from index_pilot.target_databases
    where database_name = _datname
    and enabled = true;
        
    if _fdw_server_name is null then
      raise exception using
        message = format(
          'Target database %s not registered or not enabled in index_pilot.target_databases.',
          _datname
        ),
        hint = 'Control database setup required.';
    end if;

    -- Use user mapping via postgres_fdw: dblink_connect with server name (no plaintext passwords)
    perform dblink_connect(_datname, _fdw_server_name);

  exception when others then
    raise exception using
      message = format(
        'FDW connection failed for database %s using server %s: %s',
        _datname,
        coalesce(_fdw_server_name, '<unknown>'),
        sqlerrm
      );
  end;
end;
$body$
language plpgsql;


/*
 * Establish secure dblink connection if not already connected
 * Creates secure FDW connection only if needed, handles null connections case
 */
create function index_pilot._dblink_connect_if_not(
  _datname name
) returns void as
$body$
begin
  -- Use secure FDW connection if not already connected
  -- Handle null case when no connections exist
  if dblink_get_connections() is null or not (_datname = any(dblink_get_connections())) then
    perform index_pilot._connect_securely(_datname);
  end if;
  
  return;
end;
$body$
language plpgsql;


/*
 * Comprehensive postgres_fdw security setup validation
 * Validates FDW configuration components with detailed status and guidance
 */
create function index_pilot.check_fdw_security_status() returns table(
  component text,
  status text,
  details text
) as
$body$
begin
  -- Check postgres_fdw extension
  return query select 
    'postgres_fdw extension'::text,
    case when exists (select from pg_extension where extname = 'postgres_fdw') 
      then 'INSTALLED' else 'MISSING' end::text,
    case when exists (select from pg_extension where extname = 'postgres_fdw') 
      then 'Extension is available for use' 
      else 'Run: create extension postgres_fdw;' end::text;
      
  -- Check FDW usage privilege
  return query select 
    'FDW usage privilege'::text,
    case when has_foreign_data_wrapper_privilege(current_user, 'postgres_fdw', 'usage') 
      then 'GRANTED' else 'DENIED' end::text,
    case when has_foreign_data_wrapper_privilege(current_user, 'postgres_fdw', 'usage') 
      then format('User %s can use postgres_fdw', current_user)
      else format('Run: grant usage on foreign data wrapper postgres_fdw to %s;', current_user) end::text;
  
  -- Check target servers registered
  return query select 
    'Target servers registered'::text,
    case
      when exists (select from index_pilot.target_databases) then 'YES'
      else 'NO'
    end::text,
    'Register targets: (SQL) create server + user mapping + insert into index_pilot.target_databases; or use index_pilot.sh register-target'::text;

  -- Check user mapping for current user on at least one target server
  return query select
    'User mapping for current user'::text,
    case when exists (
      select 1
      from pg_user_mappings um
      where
        um.usename = current_user
        and um.srvname in (
          select fdw_server_name
          from index_pilot.target_databases
          where enabled
        )
    ) then
      'exists'
    else
      'MISSING'
    end::text,
    'Create mapping: create user mapping for current_user server <server> options (user ''<remote_user>'', password ''<password>'');'::text;

  -- Overall security status
  return query select 
    'Overall security status'::text,
    case when (
      exists (select from pg_extension where extname = 'postgres_fdw') and
      has_foreign_data_wrapper_privilege(current_user, 'postgres_fdw', 'usage') and
      exists (select 1 from index_pilot.target_databases) and
      exists (
        select 1 from pg_user_mappings um
        where
          um.usename = current_user
          and um.srvname in (select fdw_server_name from index_pilot.target_databases where enabled)
      )
    ) then 'SECURE' else 'SETUP_REQUIRED' end::text,
    case when (
      exists (select from pg_extension where extname = 'postgres_fdw') and
      has_foreign_data_wrapper_privilege(current_user, 'postgres_fdw', 'usage') and
      exists (select 1 from index_pilot.target_databases) and
      exists (
        select 1 from pg_user_mappings um
        where
          um.usename = current_user
          and um.srvname in (select fdw_server_name from index_pilot.target_databases where enabled)
      )
    ) then 'All FDW components are properly configured'
      else 'Complete the missing setup steps above' end::text;
end;
$body$
language plpgsql;

commit;
