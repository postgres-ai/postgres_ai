# PostgresAI monitoring reference documentation

## Overview

PostgresAI monitoring is a comprehensive Postgres database monitoring solution built on pgwatch, Grafana, and Prometheus. This system provides real-time insights into Postgres database performance, health, and operations through a set of specialized dashboards.

## Architecture

The monitoring stack consists of:
- **pgwatch**: Postgres monitoring agent that collects metrics
- **Grafana**: Visualization and dashboard platform
- **Flask Backend**: Additional API services for enhanced functionality
- **prometheus and Postgres**: Storage for metrics and query texts

## Dashboard Reference

### Dashboard 1: Node Performance Overview
**Purpose**: High-level overview of Postgres database performance and health

**Key Metrics**:
- **Active session history**: Database wait events by type (CPU, locks, I/O)
- **Sessions**: Connection states (Active, Idle, Idle-in-transaction, Waiting)
- **Transactions**: Commit vs rollback ratios and rates
- **Query performance**: Calls, execution time, and latency metrics
- **Buffer cache**: Hit ratios and I/O patterns
- **WAL activity**: Write-ahead log generation and archiving

### Dashboard 2: Aggregated Query Analysis
**Purpose**: Identify top-performing and problematic queries across the database

**Key Metrics**:
- **Detailed table view**: Table of stats for each query from pg_stat_statements
- **Top queries by calls**: Most frequently executed queries
- **Top queries by execution time**: Queries consuming most total time
- **Top queries by latency**: Slowest individual query executions
- **I/O analysis**: Queries with highest disk read/write activity
- **Buffer usage**: Queries with best/worst cache efficiency
- **Temp file usage**: Queries spilling to disk for sorting/hashing
- **WAL generation**: Queries generating most write-ahead log data


### Dashboard 3: Single Query Analysis
**Purpose**: Deep-dive analysis of individual queries by query ID

**Key Metrics**:
- **Execution Timeline**: Calls and execution time over time
- **Wait Events**: Specific wait types for this query
- **Resource Usage**: Buffer hits, disk I/O, WAL generation
- **Performance Metrics**: Latency, rows returned, temp file usage
- **Per-Call Analysis**: Average metrics per query execution


### Dashboard 4: Wait sampling dashboard
**Purpose**: Detailed analysis of database wait events and blocking

**Key Metrics**:
- **Active session history**: All wait events including background processes
- **Active session history by event type**: Detailed categorization by event type
- **Active session history by event type and event**: Wait events correlated with specific queries

### Dashboard 5: Backup stats
**Purpose**: Monitor backup and recovery processes

**Key Metrics**:
- **Archive success and errors**: Rate of successful WAL archives versus failed archive attempts
- **Archive lag**: Amount of WAL data in bytes that has been generated but not yet archived
- **WAL archive success rate**: Percentage of successful WAL archive operations

### Dashboard 7: Autovacuum and bloat
**Purpose**: Monitor Postgres maintenance processes and table health

**Key Metrics**:
- **Vacuum Timeline**: Autovacuum progress through different phases


### Dashboard 8: Index health
**Purpose**: Monitor index performance and maintenance needs

**Key Metrics**:
- **Index Bloat**
- **Index Size**


### Dashboard 9: Table stats
**Purpose**: Monitor table-level operations and data patterns

**Key Metrics**:
- **CRUD operations**: Insert, update, delete rates by table


## Complete Graph Inventory

### Dashboard 1: Node Performance Overview (36 graphs)
1. **Active session history** - Shows database wait events by type (CPU, locks, I/O) to identify performance bottlenecks
2. **Host stats** - Displays system-level metrics like CPU, memory, and disk usage
3. **Postgres stats** - Core Postgres instance metrics and version information
4. **Sessions** - Connection states (Active, Idle, Idle-in-transaction, Waiting) with max_connections limit
5. **Non-idle sessions** - Active database connections excluding idle ones for workload monitoring
6. **Calls (pg_stat_statements)** - Total SQL statement executions per second across all queries
7. **Transactions** - Transaction commit vs rollback rates and overall transaction activity
9. **Commit vs rollback ratio** - Ratio of successful vs failed transactions indicating application health
10. **Statements total time (pg_stat_statements)** - Total execution time per second for all SQL statements
11. **Statements time per call (pg_stat_statements) aka latency** - Average execution time per query call (key latency metric)
12. **Total rows (pg_stat_statements)** - Total rows returned per second across all queries
13. **Rows per call (pg_stat_statements)** - Average rows returned per query execution
14. **blk_read_time vs blk_write_time (s/s) (pg_stat_statements)** - Time spent reading/writing disk blocks per second
15. **blk_read_time vs blk_write_time per call (pg_stat_statements)** - Average disk I/O time per query execution
16. **shared_blks_hit (bytes) (pg_stat_statements)** - Data read from shared buffer cache (good performance indicator)
17. **shared_blks_hit (bytes) per call (pg_stat_statements)** - Average cache hits per query execution
18. **shared_blks_read (bytes) (pg_stat_statements)** - Data read from disk (cache misses - expensive operations)
19. **shared_blks_read (bytes) per call (pg_stat_statements)** - Average disk reads per query execution
20. **shared_blks_written (bytes) (pg_stat_statements)** - Data written from buffers to disk per second
21. **shared_blks_written (bytes) per call (pg_stat_statements)** - Average buffer writes per query execution
22. **shared_blks_dirtied (bytes) (pg_stat_statements)** - Buffer blocks modified (dirtied) per second
23. **shared_blks_dirtied (bytes) per call (pg_stat_statements)** - Average buffer modifications per query
24. **shared_blks_read_ratio (pg_stat_statements)** - Cache miss ratio (< 10-20% indicates good cache efficiency)
25. **WAL bytes (pg_current_wal_lsn)** - Write-ahead log generation rate (affects replication and recovery)
26. **WAL bytes per call (pg_current_wal_lsn)** - Average WAL generation per query execution
27. **WAL fpi (pg_stat_statements)** - WAL full page images generated per second
28. **WAL fpi per call (pg_current_wal_lsn)** - Average full page images per query execution
29. **temp_bytes_read vs temp_bytes_written (pg_stat_statements)** - Temporary file I/O operations
30. **temp_bytes_read vs temp_bytes_written per call (pg_stat_statements)** - Average temp file usage per query
31. **Locks by mode** - Active locks by type (AccessShareLock, RowExclusiveLock, etc.)
32. **Longest non-idle transaction age, > 1 min** - Age of oldest active transaction (>1min threshold)
33. **Age of the oldest transaction ID that has not been frozen** - Transaction ID age (watch for wraparound issues)
34. **Age of the oldest multi-transaction ID that has not been frozen** - Multi-transaction ID age monitoring
35. **bgwriter and checkpointer** - Background writer vs checkpointer activity comparison
36. **Vacuum timeline** - VACUUM operation progress through different phases

### Dashboard 2: Aggregated Query Analysis (25 graphs)
1. **Detailed table view (pg_stat_statements)** - Tabular view of query performance metrics with sorting and filtering
2. **Top $top_n queries analysis (pg_stat_statements)** - Overview of most significant queries by multiple metrics
3. **Top $top_n statements by calls (pg_stat_statements)** - Most frequently executed queries (call frequency)
4. **Top $top_n statements by execution time (pg_stat_statements)** - Queries consuming most total execution time
5. **Top $top_n statements by execution time per call (pg_stat_statements)** - Slowest individual query executions
6. **Top $top_n statements by planning time (pg_stat_statements)** - Queries with highest total query planning time
7. **Top $top_n statements by planning time per call (pg_stat_statements)** - Queries with slowest planning per execution
8. **Top $top_n statements by rows (pg_stat_statements)** - Queries returning most total rows
9. **Top $top_n statements by rows per call (pg_stat_statements)** - Queries with highest average rows per execution
10. **Top $top_n statements by shared_blks_hit (in bytes) (pg_stat_statements)** - Queries with best cache efficiency (most hits)
11. **Top $top_n statements by shared_blks_hit (in bytes) per call (pg_stat_statements)** - Best average cache hits per query
12. **Top $top_n statements by shared_blks_read (in bytes) (pg_stat_statements)** - Queries causing most disk reads (worst cache performance)
13. **Top $top_n statements by shared_blks_read (in bytes) per call (pg_stat_statements)** - Highest average disk reads per query
14. **Top $top_n statements by shared_blks_written (in bytes) (pg_stat_statements)** - Queries writing most data to buffers
15. **Top $top_n statements by shared_blks_written (in bytes) per call (pg_stat_statements)** - Highest average buffer writes per query
16. **Top $top_n statements by shared_blks_dirtied (in bytes) per call (pg_stat_statements)** - Queries modifying most buffer data
17. **Top $top_n statements by WAL bytes (pg_stat_statements)** - Queries generating most write-ahead log data
18. **Top $top_n statements by WAL bytes per call (pg_stat_statements)** - Highest average WAL generation per query
19. **Top $top_n statements by WAL fpi (pg_stat_statements)** - Queries generating most WAL full page images
20. **Top $top_n statements by WAL fpi per call (pg_stat_statements)** - Highest average FPI generation per query
21. **Top $top_n statements by temp bytes read (pg_stat_statements)** - Queries reading most from temporary files
22. **Top $top_n statements by temp bytes read per call (pg_stat_statements)** - Highest average temp file reads per query
23. **Top $top_n statements by temp bytes written (pg_stat_statements)** - Queries writing most to temporary files
24. **Top $top_n statements by temp bytes written per call (pg_stat_statements)** - Highest average temp file writes per query
25. **Query Analysis panels (multiple instances)** - Drill-down analysis panels for individual queries

### Dashboard 3: Single Query Analysis (17 graphs)
1. **Active session history** - Wait events specifically for the selected query ID
2. **Calls (pg_stat_statements)** - Execution frequency of the specific query over time
3. **Execution time (pg_stat_statements)** - Total execution time for the specific query per second
4. **Execution time per call (pg_stat_statements)** - Average execution time per call for the specific query
5. **Rows (pg_stat_statements)** - Total rows returned by the specific query per second
6. **Rows per call (pg_stat_statements)** - Average rows returned per execution of the specific query
7. **shared_blks_hit (in bytes) (pg_stat_statements)** - Cache efficiency for the specific query (bytes from memory)
8. **shared_blks_hit (in bytes) per call (pg_stat_statements)** - Average cache hits per execution of the specific query
9. **WAL bytes (pg_stat_statements)** - WAL generation rate for the specific query
10. **WAL bytes per call (pg_stat_statements)** - Average WAL generation per execution of the specific query
11. **WAL fpi (in bytes) (pg_stat_statements)** - Full page images generated by the specific query
12. **WAL fpi per call (pg_stat_statements)** - Average FPI generation per execution of the specific query
13. **Temp bytes read (pg_stat_statements)** - Temporary file reads for the specific query
14. **Temp bytes read per call (pg_stat_statements)** - Average temp file reads per execution of the specific query
15. **Temp bytes written (pg_stat_statements)** - Temporary file writes for the specific query
16. **Temp bytes written per call (pg_stat_statements)** - Average temp file writes per execution of the specific query
17. **Query Analysis panels (multiple instances)** - Detailed analysis panels for the selected query

### Dashboard 4: Wait sampling dashboard (4 graphs)
1. **Active session history** - Comprehensive view of all database wait events including background processes
2. **Active session history by event type** - Wait events grouped by category (CPU, I/O, locks, etc.)
3. **Active session history by event type and event** - Detailed breakdown with specific event names and query IDs
4. **Query Analysis** - Drill-down analysis for queries associated with wait events

### Dashboard 5: Backup stats (3 graphs)
1. **Archive success and errors** - Rate of successful vs failed WAL archive operations
2. **WAL archive success rate** - Percentage of successful archive operations (should be 100%)
3. **Archive lag** - Amount of WAL data waiting to be archived (data loss window)

### Dashboard 7: Autovacuum and bloat (1 graph)
1. **Vacuum timeline** - Progress of VACUUM operations through phases (scanning, vacuuming, cleaning, etc.)

### Dashboard 8: Index health (6 graphs)
1. **Detailed index view** - Tabular view of all indexes with bloat, size, and usage statistics
2. **Top $top_n index analysis** - Overview of most problematic indexes by various metrics
3. **Top $top_n indexes by estimated bloat %** - Indexes with highest percentage of wasted space
4. **Top $top_n indexes by estimated bloat size** - Indexes with largest absolute amount of wasted space
5. **Top $top_n indexes by size** - Largest indexes by total size (memory and disk impact)
6. **Query Analysis panels (multiple instances)** - Detailed analysis for index-related queries

### Dashboard 9: Table stats (7 graphs)
1. **Tuple operations** - Total CRUD operations (insert, update, delete, hot update) across all tables
2. **Tuple operations (%)** - Percentage breakdown of different operation types
3. **Number of inserted tuples by table** - Insert rates for individual tables over time
4. **Number of updated tuples by table** - Update rates for individual tables (watch for bloat impact)
5. **Number of hot updated tuples by table** - HOT updates by table (efficient updates avoiding index updates)
6. **Number of deleted tuples by table** - Delete rates by table (triggers vacuum operations)
7. **Table details panels (multiple instances)** - Detailed statistics and metrics for individual tables

