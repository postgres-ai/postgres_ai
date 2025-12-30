# postgres_ai monitoring

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitLab](https://img.shields.io/badge/GitLab-postgres--ai%2Fpostgres__ai-orange?logo=gitlab)](https://gitlab.com/postgres-ai/postgres_ai)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-blue?logo=postgresql)](https://www.postgresql.org/)
[![CLI Coverage](https://img.shields.io/gitlab/pipeline-coverage/postgres-ai%2Fpostgres_ai?branch=main&job_name=cli%3Anode%3Atests&label=CLI%20coverage)](https://gitlab.com/postgres-ai/postgres_ai/-/pipelines)
[![Reporter Coverage](https://img.shields.io/gitlab/pipeline-coverage/postgres-ai%2Fpostgres_ai?branch=main&job_name=reporter%3Atests&label=Reporter%20coverage)](https://gitlab.com/postgres-ai/postgres_ai/-/pipelines)

**Expert-level Postgres monitoring tool designed for humans and AI systems**

Built for senior DBAs, SREs, and AI systems who need rapid root cause analysis and deep performance insights. This isn't a tool for beginners — it's designed for Postgres experts who need to understand complex performance issues in minutes, not hours.

**Part of [Self-Driving Postgres](https://postgres.ai/blog/20250725-self-driving-postgres)** - postgres_ai monitoring is a foundational component of PostgresAI's open-source Self-Driving Postgres (SDP) initiative, providing the advanced monitoring and intelligent root cause analysis capabilities essential for achieving higher levels of database automation.

![postgres_ai monitoring](assets/postgres_ai_pic.png)

## 🎯 Key highlights

- **Top-down troubleshooting methodology**: Follows the Four Golden Signals approach (Latency, Traffic, Errors, Saturation)
- **Expert-focused design**: Assumes deep Postgres knowledge and performance troubleshooting experience  
- **Dual-purpose architecture**: Built for both human experts and AI systems requiring structured performance data
- **Comprehensive query analysis**: Complete `pg_stat_statements` metrics with historical trends and plan variations
- **Active Session History**: Postgres's answer to Oracle ASH and AWS RDS Performance Insights
- **Hybrid storage**: Victoria Metrics (Prometheus-compatible) for metrics, Postgres for query texts — best of both worlds

> 📖 **Read more**: [postgres_ai monitoring v0.7 announcement](https://postgres.ai/blog/20250722-postgres-ai-v0-7-expert-level-postgresql-monitoring) - detailed technical overview and architecture decisions.

## ⚠️ Important notice

**This tool is NOT for beginners.** It requires extensive Postgres knowledge and assumes familiarity with:
- Advanced Postgres internals and performance concepts
- Query plan analysis and optimization techniques  
- Wait event analysis and system-level troubleshooting
- Production database operations and incident response

If you're new to Postgres, consider starting with simpler monitoring solutions before using postgres_ai.

## 🚀 Live demo

Experience the full monitoring solution: **https://demo.postgres.ai** (login: `demo` / password: `demo`)

## 📊 Five expert dashboards

1. **Troubleshooting dashboard** - Four Golden Signals with immediate incident response insights
2. **Query performance analysis** - Top-N query workload analysis with resource consumption breakdowns  
3. **Single query analysis** - Deep dive into individual query performance and plan variations
4. **Wait event analysis** - Active Session History for session-level troubleshooting
5. **Backups and DR** - WAL archiving monitoring with RPO measurements

## 🏗️ Architecture

- **Collection**: pgwatch v3 (by Cybertec) for metrics gathering
- **Storage**: Victoria Metrics for time-series data + Postgres for query texts
- **Visualization**: Grafana with expert-designed dashboards
- **Analysis**: Structured data output for AI system integration

## 📋 Requirements

**Infrastructure:**
- **Linux machine** with Docker installed (separate from your database server)
- **Docker access** - the user running `postgres_ai` must have Docker permissions
- **Access (network and pg_hba)** to the Postgres database(s) you want to monitor

**Database:**
- Supports Postgres versions 14-18
- **pg_stat_statements extension must be created** for the DB used for connection

## 🚀 Quick start

Create a database user for monitoring (skip this if you want to just check out `postgres_ai` monitoring with a synthetic `demo` database).

Use the CLI to create/update the monitoring role and grant all required permissions (idempotent):

```bash
# Connect as an admin/superuser and run the idempotent setup:
# - create/update the monitoring role
# - create required view(s)
# - apply required grants (and optional extensions where supported)
# Admin password comes from PGPASSWORD (libpq standard) unless you pass --admin-password.
#
# Monitoring password:
# - by default, postgresai generates a strong password automatically
# - it is printed only in interactive (TTY) mode, or if you opt in via --print-password
PGPASSWORD='...' npx postgresai prepare-db postgresql://admin@host:5432/dbname
```

Optional permissions (RDS/self-managed extras) are enabled by default. To skip them:

```bash
PGPASSWORD='...' npx postgresai prepare-db postgresql://admin@host:5432/dbname --skip-optional-permissions
```

Verify everything is in place (no changes):

```bash
PGPASSWORD='...' npx postgresai prepare-db postgresql://admin@host:5432/dbname --verify
```

If you want to reset the monitoring password only (no other changes), you can rely on auto-generation:

```bash
PGPASSWORD='...' npx postgresai prepare-db postgresql://admin@host:5432/dbname --reset-password
```

By default, `postgresai prepare-db` auto-generates a strong password (see above).

If you want to set a specific password instead:

```bash
PGPASSWORD='...' npx postgresai prepare-db postgresql://admin@host:5432/dbname --reset-password --password 'new_password'
```

If you want to see what will be executed first, use `--print-sql` (prints the SQL plan and exits; passwords redacted by default). This can be done without a DB connection:

```bash
npx postgresai prepare-db --print-sql
```

Optionally, to render the plan for a specific database:

```bash
# Pick database (default is PGDATABASE or "postgres"):
npx postgresai prepare-db --print-sql -d dbname

# Provide an explicit monitoring password (still redacted in output):
npx postgresai prepare-db --print-sql -d dbname --password '...'
```

### Troubleshooting

**Permission denied errors**

If you see errors like `permission denied` / `insufficient_privilege` / code `42501`, you are not connected with enough privileges to create roles, grant permissions, or create extensions/views.

- **How to fix**:
  - Connect as a **superuser**, or a role with **CREATEROLE** and sufficient **GRANT/DDL** privileges
  - On RDS/Aurora: use a user with the `rds_superuser` role (typically `postgres`, the most highly privileged user on RDS for PostgreSQL)
  - On Cloud SQL: use a user with the `cloudsqlsuperuser` role (often `postgres`)
  - On Supabase: use the `postgres` user (default administrator with elevated privileges for role/permission management)
  - On managed providers: use the provider’s **admin** role/user

- **Review SQL before running** (audit-friendly):

    ```bash
    npx postgresai prepare-db --print-sql -d mydb
    ```

**Install the CLI:**

```bash
npm install -g postgresai
```

**Start monitoring:**

To obtain a PostgresAI access token for your organization, visit https://console.postgres.ai (`Your org name → Manage → Access tokens`):

```bash
# Production setup with your Access token
postgresai mon local-install --api-key=your_access_token
```
**Note:** You can also add your database instance in the same command:
```bash
postgresai mon local-install --api-key=your_access_token --db-url="postgresql://user:pass@host:port/DB"
```

Or if you want to just check out how it works:
```bash
# Complete setup with demo database
postgresai mon local-install --demo
```

That's it! Everything is installed, configured, and running.

## ⚠️ Security Notice

**WARNING: Security is your responsibility!**

This monitoring solution exposes several ports that **MUST** be properly firewalled:
- **Port 3000** (Grafana) - Contains sensitive database metrics and dashboards
- **Port 58080** (PGWatch Postgres) - Database monitoring interface  
- **Port 58089** (PGWatch Prometheus) - Database monitoring interface
- **Port 59090** (Victoria Metrics) - Metrics storage and queries
- **Port 59091** (PGWatch Prometheus endpoint) - Metrics collection
- **Port 55000** (Metrics Server) - Backend API service
- **Port 55432** (Demo DB) - When using `--demo` option
- **Port 55433** (Metrics DB) - Postgres metrics storage

**Configure your firewall to:**
- Block public access to all monitoring ports
- Allow access only from trusted networks/IPs
- Use VPN or SSH tunnels for remote access

Failure to secure these ports may expose sensitive database information!

## 📊 What you get

- **Grafana Dashboards** - Visual monitoring at http://localhost:3000
- **Postgres Monitoring** - PGWatch with comprehensive metrics
- **Automated Reports** - Daily performance analysis
- **API Integration** - Automatic upload to PostgresAI
- **Demo Database** - Ready-to-use test environment

## 🎯 Use cases

**For developers:**
```bash
postgresai mon local-install --demo
```
Get a complete monitoring setup with demo data in under 2 minutes.

**For production:**
```bash
postgresai mon local-install --api-key=your_key
# Then add your databases
postgresai mon targets add "postgresql://user:pass@host:port/DB"
```

## 🔧 Management commands

```bash
# Instance management
postgresai mon targets add "postgresql://user:pass@host:port/DB"
postgresai mon targets list
postgresai mon targets test my-DB

# Service management
postgresai mon status
postgresai mon logs
postgresai mon restart

# Health check
postgresai mon health
```

## 📋 Checkup reports

postgres_ai monitoring generates automated health check reports based on [postgres-checkup](https://gitlab.com/postgres-ai/postgres-checkup). Each report has a unique check ID and title:

### A. General / Infrastructural
| Check ID | Title |
|----------|-------|
| A001 | System information |
| A002 | Version information |
| A003 | Postgres settings |
| A004 | Cluster information |
| A005 | Extensions |
| A006 | Postgres setting deviations |
| A007 | Altered settings |
| A008 | Disk usage and file system type |

### D. Monitoring / Troubleshooting
| Check ID | Title |
|----------|-------|
| D004 | pg_stat_statements and pg_stat_kcache settings |

### F. Autovacuum, Bloat
| Check ID | Title |
|----------|-------|
| F001 | Autovacuum: current settings |
| F004 | Autovacuum: heap bloat (estimated) |
| F005 | Autovacuum: index bloat (estimated) |

### G. Performance / Connections / Memory-related settings
| Check ID | Title |
|----------|-------|
| G001 | Memory-related settings |

### H. Index analysis
| Check ID | Title |
|----------|-------|
| H001 | Invalid indexes |
| H002 | Unused indexes |
| H004 | Redundant indexes |

### K. SQL query analysis
| Check ID | Title |
|----------|-------|
| K001 | Globally aggregated query metrics |
| K003 | Top queries by total time (total_exec_time + total_plan_time) |
| K004 | Top queries by temp bytes written |
| K005 | Top queries by WAL generation |
| K006 | Top queries by shared blocks read |
| K007 | Top queries by shared blocks hit |

### M. SQL query analysis (top queries)
| Check ID | Title |
|----------|-------|
| M001 | Top queries by mean execution time |
| M002 | Top queries by rows (I/O intensity) |
| M003 | Top queries by I/O time |

### N. Wait events analysis
| Check ID | Title |
|----------|-------|
| N001 | Wait events grouped by type and query |

## 🌐 Access points

After running local-install:

- **🚀 MAIN: Grafana Dashboard**: http://localhost:3000 (login: `monitoring`; password is shown at the end of local-install)

Technical URLs (for advanced users):
- **Demo DB**: postgresql://postgres:postgres@localhost:55432/target_database
- **Monitoring**: http://localhost:58080 (PGWatch)
- **Metrics**: http://localhost:59090 (Victoria Metrics)

## 📖 Help

```bash
postgresai --help
postgresai mon --help
```

## 🔑 PostgresAI access token
Get your access token at [PostgresAI](https://postgres.ai) for automated report uploads and advanced analysis.

## 🛣️ Roadmap

- Host stats for on-premise and managed Postgres setups
- `pg_wait_sampling` and `pg_stat_kcache` extension support
- Additional expert dashboards: autovacuum, checkpointer, lock analysis
- Query plan analysis and automated recommendations
- Enhanced AI integration capabilities

## 🧪 Testing

Python-based report generation lives under `reporter/` and now ships with a pytest suite.

### Installation

Install dev dependencies (includes `pytest`, `pytest-postgresql`, `psycopg`, etc.):
```bash
python3 -m pip install -r reporter/requirements-dev.txt
```

### Running Tests

#### Unit Tests Only (Fast, No External Services Required)

Run only unit tests with mocked Prometheus interactions:
```bash
pytest tests/reporter
```

This automatically skips integration tests. Or run specific test files:
```bash
pytest tests/reporter/test_generators_unit.py -v
pytest tests/reporter/test_formatters.py -v
```

#### All Tests: Unit + Integration (Requires PostgreSQL)

Run the complete test suite (both unit and integration tests):
```bash
pytest tests/reporter --run-integration
```

Integration tests create a temporary PostgreSQL instance automatically and require PostgreSQL binaries (`initdb`, `postgres`) on your PATH. No manual database setup or environment variables are required - the tests create and destroy their own temporary PostgreSQL instances.

**Summary:**
- `pytest tests/reporter` → **Unit tests only** (integration tests skipped)
- `pytest tests/reporter --run-integration` → **Both unit and integration tests**

### Test Coverage

Generate coverage report:
```bash
pytest tests/reporter -m unit --cov=reporter --cov-report=html
```

View the coverage report by opening `htmlcov/index.html` in your browser.

## 🤝 Contributing

We welcome contributions from Postgres experts! Please check our [GitLab repository](https://gitlab.com/postgres-ai/postgres_ai) for:
- Code standards and review process
- Dashboard design principles
- Testing requirements for monitoring components

## 📄 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## 🏢 About PostgresAI

postgres_ai monitoring is developed by [PostgresAI](https://postgres.ai), bringing years of Postgres expertise into automated monitoring and analysis tools. We provide enterprise consulting and advanced Postgres solutions for fast-growing companies.

## 📞 Support & community

- 💬 [Get support](https://postgres.ai/contact)
- 📺 [Postgres.TV (YouTube)](https://postgres.tv)
- 🎙️ [Postgres FM Podcast](https://postgres.fm)
- 🐛 [Report issues](https://gitlab.com/postgres-ai/postgres_ai/-/issues)
- 📧 [Enterprise support](https://postgres.ai/consulting)

