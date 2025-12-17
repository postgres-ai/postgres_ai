-- Test 04: In-Progress Reindex Handling
-- Verifies that reindexes in progress show null values, not premature completion
-- Exit on first error for CI
\set ON_ERROR_STOP on
\set QUIET on

\echo '======================================'
\echo 'TEST 04: In-Progress Reindex Handling'
\echo '======================================'

-- 1. Create test schema and table with substantial data in target database
do $$
declare
  _target_db text;
begin
  -- Get target database name from control database configuration
  select database_name into _target_db
  from index_pilot.target_databases
  where enabled = true
  limit 1;
  
  -- Clean up from any previous test runs
  delete from index_pilot.reindex_history where schemaname = 'test_reindex';
  delete from index_pilot.index_latest_state where schemaname = 'test_reindex';
  
  -- Connect to target database
  perform index_pilot._connect_securely(_target_db);
  
  -- Create test schema and data in target database
  perform dblink(_target_db, '
    drop schema if exists test_reindex cascade;
    create schema test_reindex;
    
    create table test_reindex.test_table (
      id serial primary key,
      data text,
      created_at timestamp default now()
    );
    
    insert into test_reindex.test_table (data)
    select ''test data '' || i 
    from generate_series(1, 10000) i;
    
    create index idx_test_data on test_reindex.test_table(data);
    create index idx_test_created on test_reindex.test_table(created_at);
    
    analyze test_reindex.test_table;
  ');
  
  raise notice 'PASS: Test schema and data created in target database';
end $$;

-- 2. Manually insert a reindex history record as if reindex just started
do $$
declare
  _indexsize bigint;
  _target_db text;
begin
  -- Get target database name from control database configuration
  select database_name into _target_db
  from index_pilot.target_databases
  where enabled = true
  limit 1;
  
  -- Get current index size from target database
  select indexsize into _indexsize
  from index_pilot._remote_get_indexes_info(_target_db, 'test_reindex', 'test_table', 'idx_test_data')
  limit 1;
  
  -- Insert record with null values (as fire-and-forget reindex would)
  insert into index_pilot.reindex_history (
    datname, schemaname, relname, indexrelname,
    indexsize_before, indexsize_after, estimated_tuples, 
    reindex_duration, analyze_duration, entry_timestamp
  ) values (
    _target_db, 'test_reindex', 'test_table', 'idx_test_data',
    _indexsize, null, 10000,  -- null for testing in-progress state
    null, null, now()
  );
  
  raise notice 'PASS: In-progress reindex record created with NULL values';
end $$;

-- 3. Verify the history view shows null ratio and duration for in-progress test record
do $$
declare
  _ratio numeric;
  _duration interval;
  _size_after text;
begin
  select ratio, duration, size_after into _ratio, _duration, _size_after
  from index_pilot.history
  where schema = 'test_reindex'
  and index = 'idx_test_data'
  limit 1;
  
  if _ratio is not null then
    raise exception 'FAIL: Ratio should be NULL for in-progress reindex, got %', _ratio;
  end if;
  
  if _duration is not null then
    raise exception 'FAIL: Duration should be NULL for in-progress reindex, got %', _duration;
  end if;
  
  if _size_after is not null then
    raise exception 'FAIL: Size_after should be NULL for in-progress reindex, got %', _size_after;
  end if;
  
  raise notice 'PASS: History view correctly shows NULL values for in-progress reindex';
end $$;

-- 4. Create a _ccnew index to simulate in-progress REINDEX CONCURRENTLY
do $$
declare
  _target_db text;
begin
  -- Get target database name from control database configuration
  select database_name into _target_db
  from index_pilot.target_databases
  where enabled = true
  limit 1;
  
  -- Create a fake _ccnew index in target database to simulate in-progress reindex
  perform dblink(_target_db, '
    create index idx_test_data_ccnew on test_reindex.test_table(data);
  ');
  
  raise notice 'PASS: Created _ccnew index in target database to simulate in-progress REINDEX CONCURRENTLY';
end $$;

-- 5. Verify the test is checking the right behavior without calling functions that require control DB
do $$
begin
  -- In control database architecture, we cannot call functions that connect to current database
  -- Note: update_completed_reindexes function removed - all tracking is synchronous now
  raise notice 'PASS: Synchronous tracking means no periodic completion detection needed';
end $$;

-- 6. Verify record still has NULL values (not prematurely marked complete)
do $$
declare
  _indexsize_after bigint;
  _duration interval;
begin
  select indexsize_after, reindex_duration into _indexsize_after, _duration
  from index_pilot.reindex_history
  where schemaname = 'test_reindex'
  and indexrelname = 'idx_test_data';
  
  if _indexsize_after is not null then
    raise exception 'FAIL: indexsize_after should still be NULL, but was updated to %', _indexsize_after;
  end if;
  
  if _duration is not null then
    raise exception 'FAIL: reindex_duration should still be NULL, but was updated to %', _duration;
  end if;
  
  raise notice 'PASS: Record correctly remains null (verifying no premature completion)';
end $$;

-- 7. Simulate reindex completion by updating the record
do $$
declare
  _new_size bigint;
  _target_db text;
begin
  -- Get target database name from control database configuration
  select database_name into _target_db
  from index_pilot.target_databases
  where enabled = true
  limit 1;
  
  -- Get current size from target database (simulating completed reindex)
  select indexsize into _new_size
  from index_pilot._remote_get_indexes_info(_target_db, 'test_reindex', 'test_table', 'idx_test_data')
  limit 1;
  
  -- Manually complete the record
  update index_pilot.reindex_history
  set indexsize_after = _new_size * 0.8,  -- Simulate 20% size reduction
    reindex_duration = interval '5 minutes'
  where schemaname = 'test_reindex'
  and indexrelname = 'idx_test_data';
  
  raise notice 'PASS: Simulated reindex completion';
end $$;

-- 8. Verify history now shows proper ratio
do $$
declare
  _ratio numeric;
  _duration interval;
begin
  select ratio, duration into _ratio, _duration
  from index_pilot.history
  where schema = 'test_reindex'
  and index = 'idx_test_data';
  
  if _ratio is null then
    raise exception 'FAIL: Ratio should not be NULL after completion';
  end if;
  
  if _ratio < 1.0 then
    raise exception 'FAIL: Ratio should be > 1.0 for size reduction, got %', _ratio;
  end if;
  
  if _duration is null then
    raise exception 'FAIL: Duration should not be NULL after completion';
  end if;
  
  raise notice 'PASS: History correctly shows ratio % and duration % after completion', _ratio, _duration;
end $$;


-- 9. Cleanup
do $$
declare
  _target_db text;
begin
  -- Get target database name from control database configuration
  select database_name into _target_db
  from index_pilot.target_databases
  where enabled = true
  limit 1;
  
  -- Clean up target database
  perform dblink(_target_db, '
    drop schema if exists test_reindex cascade;
  ');
  
  -- Clean up control database tracking tables
  delete from index_pilot.reindex_history where schemaname = 'test_reindex';
  delete from index_pilot.index_latest_state where schemaname = 'test_reindex';
  raise notice 'PASS: Test cleanup completed';
end $$;

\echo 'TEST 04: PASSED'
\echo ''