# Grafana Dashboards Naming Conventions

This document outlines the naming principles used in PostgresAI Grafana dashboards.

## Terminology Rules

### Bloat Metrics
Always use **"Estimated bloat"** when referring to bloat metrics. The bloat
values shown in these dashboards are based on estimation queries that use
pg_stat_user_tables statistics - they are not precise measurements like
pgstattuple would provide.

**Correct:**
- "Estimated bloat %"
- "Estimated bloat size"
- "Top $top_n tables by estimated bloat %"

**Incorrect:**
- "Bloat %"
- "Bloat size"

### Shared Block I/O
Use **"Shared block reads"** and **"Shared block hits"** - these are the correct
PostgreSQL terminology.

- **Shared block hits**: Data was found in PostgreSQL's shared buffer pool
- **Shared block reads**: Data was read into the shared buffer pool from the OS
  page cache. Note: This does NOT necessarily mean a disk read occurred - the data
  may have been served from the OS file system cache.

**Correct:**
- "Shared block reads"
- "Shared block hits"
- "Shared block hit ratio"

**Incorrect:**
- "Block disk reads" (we don't know if actual disk I/O occurred)
- "Block cache hits" (ambiguous - could mean OS cache or PG buffer pool)

### Rate Metrics
For rate-based panels (showing per-second values), append `/s` to the title:

**Examples:**
- "Tuple operations /s"
- "Size growth /s"
- "Shared block hits /s"

### Section (Row) Naming
- **"Activity stats"**: For table dashboards showing tuple operations
- **"Index usage stats"**: For index dashboards showing scan/fetch metrics
- **"Estimated bloat stats"**: For bloat-related metrics (always include "Estimated")
- **"IO stats"**: For shared buffer pool I/O metrics
- **"Size stats"**: For size-related metrics

## Units

- **binBps**: Use binary bytes per second (KiB/s, MiB/s, GiB/s) for PostgreSQL
  block I/O rates, as PostgreSQL uses binary block sizes (typically 8 KiB)
- **bytes**: Use for absolute size measurements
- **percent**: Use for percentage values (0-100 scale)
- **ops**: Use for operations per second
