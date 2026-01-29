# PostgresAI Express Checkup - Multi-Language SDKs

Lightweight libraries for running PostgreSQL health checks directly from your application.
No external dependencies beyond PostgreSQL connectivity.

## Available SDKs

| Language | Package | Install |
|----------|---------|---------|
| Python | `postgresai-checkup` | `pip install postgresai-checkup` |
| Ruby | `postgresai_checkup` | `gem install postgresai_checkup` |
| TypeScript | `postgresai-checkup` | `npm install postgresai-checkup` |

## Available Checks

| ID | Name | Description |
|----|------|-------------|
| A002 | Postgres version | Get PostgreSQL major version |
| H001 | Invalid indexes | Find indexes with `indisvalid = false` |
| H002 | Unused indexes | Find indexes that have never been scanned |
| H004 | Redundant indexes | Find indexes covered by other indexes |
| F004 | Table bloat | Estimate heap bloat from dead tuples |

## Quick Start

### Python

```python
from postgresai_checkup import Checkup

# Standalone
checkup = Checkup("postgresql://user:pass@localhost:5432/mydb")
reports = checkup.run_all()

# Print summary
for check_id, result in reports.items():
    print(f"{check_id}: {result.check_title}")
    print(result.to_json())
```

**Django Integration:**

```python
# In your Django app
from postgresai_checkup.django import run_checkup

# Run all checks
results = run_checkup()

# Run specific check
h002_result = run_checkup(check_id="H002")
```

**Management Command:**

```bash
python manage.py pgai_checkup
python manage.py pgai_checkup --check-id H002
python manage.py pgai_checkup --output json
```

### Ruby

```ruby
require 'postgresai_checkup'

# Standalone
checkup = PostgresAI::Checkup.new("postgresql://user:pass@localhost:5432/mydb")
reports = checkup.run_all

# Print summary
reports.each do |check_id, result|
  puts "#{check_id}: #{result.check_title}"
  puts result.to_json
end
```

**Rails Integration:**

```ruby
# In your Rails app
checkup = PostgresAI::Checkup.from_active_record
reports = checkup.run_all
```

**Rake Tasks:**

```bash
rails postgresai:checkup
rails postgresai:checkup[H002]
rails postgresai:checkup:json
rails postgresai:checkup:list
```

### TypeScript

```typescript
import { Client } from 'pg';
import { Checkup } from 'postgresai-checkup';

// Create checkup with any PostgreSQL client
const client = new Client('postgresql://user:pass@localhost:5432/mydb');
await client.connect();

const checkup = new Checkup(async (sql) => {
  const result = await client.query(sql);
  return result.rows;
});

// Run all checks
const reports = await checkup.runAll();

// Run specific check
const h002Report = await checkup.runCheck('H002');

console.log(JSON.stringify(reports, null, 2));
```

**With porsager/postgres:**

```typescript
import postgres from 'postgres';
import { Checkup } from 'postgresai-checkup';

const sql = postgres('postgresql://...');
const checkup = new Checkup(async (query) => sql.unsafe(query));
const reports = await checkup.runAll();
```

**With Drizzle ORM:**

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Checkup } from 'postgresai-checkup';

const db = drizzle(pool);
const checkup = new Checkup(async (sql) => {
  const result = await db.execute(sql);
  return result.rows;
});
```

## Output Format

All SDKs produce JSON output matching the PostgresAI report schema:

```json
{
  "checkId": "H002",
  "checkTitle": "Unused indexes",
  "timestamptz": "2024-01-15T10:30:00.000Z",
  "generation_mode": "express",
  "nodes": {
    "primary": "node-01",
    "standbys": []
  },
  "results": {
    "node-01": {
      "data": {
        "mydb": {
          "unused_indexes": [
            {
              "schema_name": "public",
              "table_name": "users",
              "index_name": "idx_users_old",
              "index_definition": "CREATE INDEX idx_users_old ON public.users USING btree (email)",
              "reason": "Never Used Indexes",
              "idx_scan": 0,
              "index_size_bytes": 8192,
              "idx_is_btree": true,
              "supports_fk": false,
              "index_size_pretty": "8.00 KiB"
            }
          ],
          "total_count": 1,
          "total_size_bytes": 8192,
          "total_size_pretty": "8.00 KiB",
          "database_size_bytes": 10485760,
          "database_size_pretty": "10.00 MiB",
          "stats_reset": {
            "stats_reset_epoch": 1704067200.0,
            "stats_reset_time": "2024-01-01 00:00:00+00",
            "days_since_reset": 14
          }
        }
      },
      "postgres_version": {
        "version": "16.1",
        "server_version_num": "160001",
        "server_major_ver": "16",
        "server_minor_ver": "1"
      }
    }
  }
}
```

## Architecture

These SDKs are designed to be:

1. **Lightweight** - No external dependencies beyond a PostgreSQL client
2. **Framework-agnostic** - Work standalone or with any ORM/framework
3. **Portable** - Same SQL queries across all languages
4. **Schema-compliant** - Output matches the PostgresAI JSON schemas

### How It Works

1. **Version Detection** - Query `pg_settings` for `server_version_num`
2. **Execute Checks** - Run predefined SQL queries against system catalogs
3. **Format Results** - Transform query results into structured JSON
4. **Return Report** - JSON matching the PostgresAI schema

### SQL Queries

All SDKs use the same SQL queries, derived from the main PostgresAI metrics.
The queries use only standard PostgreSQL system catalogs:

- `pg_index` - Index metadata
- `pg_class` - Table/index sizes
- `pg_stat_user_indexes` - Index usage statistics
- `pg_stat_user_tables` - Table statistics
- `pg_stat_database` - Database-wide statistics

No extensions required (though `pg_stat_statements` is used if available).

## Contributing

To add a new check:

1. Add the SQL query to each SDK
2. Add the check metadata to `AVAILABLE_CHECKS`
3. Implement the check method
4. Test against a real PostgreSQL database

## License

MIT License - see [LICENSE](../../LICENSE) for details.
