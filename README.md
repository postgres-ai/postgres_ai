# postgres_ai monitoring

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitLab](https://img.shields.io/badge/GitLab-postgres--ai%2Fpostgres__ai-orange?logo=gitlab)](https://gitlab.com/postgres-ai/postgres_ai)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-blue?logo=postgresql)](https://www.postgresql.org/)

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
- **Access (network and `pg_hba.conf`)** to the Postgres database(s) you want to monitor

**Database:**
- Supports Postgres 14-18
- **pg_stat_statements extension must be created** for the database used for the connection

## ⚠️ Security notice

**WARNING: Security is your responsibility!**

This monitoring solution exposes several ports that **MUST** be properly firewalled:
- **Port 3000** (Grafana) - Contains sensitive database metrics and dashboards
- **Port 58080** (PGWatch Postgres) - Database monitoring interface  
- **Port 58089** (PGWatch Prometheus) - Database monitoring interface
- **Port 59090** (Victoria Metrics) - Metrics storage and queries
- **Port 59091** (PGWatch Prometheus endpoint) - Metrics collection
- **Port 55000** (Flask API) - Backend API service
- **Port 55432** (Demo DB) - When using `--demo` option
- **Port 55433** (Metrics DB) - Postgres metrics storage

**Configure your firewall to:**
- Block public access to all monitoring ports
- Allow access only from trusted networks/IPs
- Use VPN or SSH tunnels for remote access

Failure to secure these ports may expose sensitive database information!

## 🚀 Quick start

Create a new DB user in the database to be monitored (skip this if you want to just check out `postgres_ai` monitoring with a synthetic `demo` database):
```sql
-- Create a user for postgres_ai monitoring
begin;
create user postgres_ai_mon with password '<password>';

grant connect on database <database_name> to postgres_ai_mon;

grant pg_monitor to postgres_ai_mon;
grant select on pg_index to postgres_ai_mon;

-- Create a public view for pg_statistic access (optional, for bloat analysis)
create view public.pg_statistic as
select 
    n.nspname as schemaname,
    c.relname as tablename,
    a.attname,
    s.stanullfrac as null_frac,
    s.stawidth as avg_width,
    false as inherited
from pg_statistic s
join pg_class c on c.oid = s.starelid
join pg_namespace n on n.oid = c.relnamespace  
join pg_attribute a on a.attrelid = s.starelid and a.attnum = s.staattnum
where a.attnum > 0 and not a.attisdropped;

grant select on public.pg_statistic to postgres_ai_mon;
alter user postgres_ai_mon set search_path = "$user", public, pg_catalog;
commit;
```

### Optional permissions to analyze risks of certain performance cliffs

For RDS Postgres and Aurora:

```sql
create extension if not exists rds_tools;
grant execute on function rds_tools.pg_ls_multixactdir() to postgres_ai_mon;
```

For self-managed Postgres:

```sql
grant execute on function pg_stat_file(text) to postgres_ai_mon;
grant execute on function pg_stat_file(text, boolean) to postgres_ai_mon;
grant execute on function pg_ls_dir(text) to postgres_ai_mon;
grant execute on function pg_ls_dir(text, boolean, boolean) to postgres_ai_mon;
```

**One command setup:**

```bash
# Download the CLI
curl -o postgres_ai https://gitlab.com/postgres-ai/postgres_ai/-/raw/main/postgres_ai \
  && chmod +x postgres_ai
```

Now, start it and wait for a few minutes. To obtain a PostgresAI access token for your organization, visit https://console.postgres.ai (`Your org name → Manage → Access tokens`):

```bash
# Production setup with your access token
./postgres_ai quickstart --api-key=your_access_token
```
**Note:** You can also add your database instance in the same command:
```bash
./postgres_ai quickstart --api-key=your_access_token --add-instance="postgresql://user:pass@host:port/DB"
```

Or if you want to just check out how it works:
```bash
# Complete setup with demo database
./postgres_ai quickstart --demo
```

That's it! Everything is installed, configured, and running.

## 📊 What you get

- **Grafana Dashboards** - Visual monitoring at http://localhost:3000
- **Postgres Monitoring** - PGWatch with comprehensive metrics
- **Automated Reports** - Daily performance analysis
- **API Integration** - Automatic upload to PostgresAI
- **Demo Database** - Ready-to-use test environment

## 🎯 Use cases

**For developers:**
```bash
./postgres_ai quickstart --demo
```
Get a complete monitoring setup with demo data in under 2 minutes.

**For production:**
```bash
./postgres_ai quickstart --api-key=your_key
# Then add your databases
./postgres_ai add-instance "postgresql://user:pass@host:port/DB"
```

## 🔧 Management commands

```bash
# Instance management
./postgres_ai add-instance "postgresql://user:pass@host:port/DB"
./postgres_ai list-instances
./postgres_ai test-instance my-DB

# Service management  
./postgres_ai status
./postgres_ai logs
./postgres_ai restart

# Health check
./postgres_ai health
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
| K003 | Top-50 queries by total_time |

## 🌐 Access points

After running quickstart:

- **🚀 MAIN: Grafana Dashboard**: http://localhost:3000 (login: `monitoring`; password is shown at the end of quickstart)

Technical URLs (for advanced users):
- **Demo DB**: postgresql://postgres:postgres@localhost:55432/target_database
- **Monitoring**: http://localhost:58080 (PGWatch)
- **Metrics**: http://localhost:59090 (Victoria Metrics)

## 📖 Help

```bash
./postgres_ai help
```

### Node.js CLI (early preview)

```bash
# Run without installing
node ./cli/bin/postgres-ai.js --help

# Local development: install aliases into PATH
npm --prefix cli install --no-audit --no-fund
npm link ./cli
postgres-ai --help
pgai --help

# or install globally after publish (planned)
# npm i -g @postgresai/cli
# postgres-ai --help
# pgai --help
```

## 🔑 PostgresAI access token
Get your access token at [PostgresAI](https://postgres.ai) for automated report uploads and advanced analysis.

## 🛣️ Roadmap

- Host stats for on-premises and managed Postgres setups
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

### Running tests

#### Unit tests only (fast, no external services required)

Run only unit tests with mocked Prometheus interactions:
```bash
pytest tests/reporter
```

This automatically skips integration tests. Or run specific test files:
```bash
pytest tests/reporter/test_generators_unit.py -v
pytest tests/reporter/test_formatters.py -v
```

#### All tests: unit + integration (requires PostgreSQL)

Run the complete test suite (both unit and integration tests):
```bash
pytest tests/reporter --run-integration
```

Integration tests create a temporary PostgreSQL instance automatically and require PostgreSQL binaries (`initdb`, `postgres`) on your PATH. No manual database setup or environment variables are required - the tests create and destroy their own temporary PostgreSQL instances.

**Summary:**
- `pytest tests/reporter` → **Unit tests only** (integration tests skipped)
- `pytest tests/reporter --run-integration` → **Both unit and integration tests**

### Test coverage

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

