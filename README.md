# Postgres AI 

A complete PostgreSQL monitoring solution with automated performance analysis and reporting.

## 📋 Requirements

- Supports PostgreSQL versions 14-17

## 🚀 Quick start

Create a new DB user in database to be monitored (skip this if you want just to check out `postgres_ai` monitoring with a synthetic `demo` database):
```sql
-- Create a user for Postgres AI monitoring
create user postgres_ai_mon with password '<password>';

grant connect on database <database_name> to postgres_ai_mon;

grant pg_monitor to postgres_ai_mon;
grant usage on schema public to postgres_ai_mon;
grant select on all tables in schema public to postgres_ai_mon; -- TEMPORARY; TODO: get rid of this
grant select on all sequences in schema public to postgres_ai_mon;

grant select on pg_stat_statements to postgres_ai_mon;
grant select on pg_stat_database to postgres_ai_mon;
grant select on pg_stat_user_tables to postgres_ai_mon;
```

**One command setup:**

```bash
# Download the CLI
curl -o postgres_ai https://gitlab.com/postgres-ai/postgres_ai/-/raw/main/postgres_ai \
  && chmod +x postgres_ai
```

Now, start it and wait for a few minutes. Two optional adjustments:
- remove `--demo` unless you want to see it in action without monitoring an actual Postgres DB (this option creates a demo DB)
- get an Postgres AI access token for your organization at https://console.postgres.ai (`Your org name → Manage → Access tokens`)

```bash
# Complete setup with demo database
./postgres_ai quickstart --demo

# Production setup with your API key
./postgres_ai quickstart --api-key=your_api_key
```

That's it! Everything is installed, configured, and running.

## 📊 What you get

- **Grafana Dashboards** - Visual monitoring at http://localhost:3000
- **PostgreSQL Monitoring** - PGWatch with comprehensive metrics
- **Automated Reports** - Daily performance analysis
- **API Integration** - Automatic upload to PostgreSQL AI
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
./postgres_ai add-instance "postgresql://user:pass@host:port/db"
```

**For CI/CD:**
```bash
./postgres_ai quickstart --demo --api-key=$API_KEY
```
Fully automated setup with no interactive prompts.

## 🔧 Management commands

```bash
# Instance management
./postgres_ai add-instance "postgresql://user:pass@host:port/db"
./postgres_ai list-instances
./postgres_ai test-instance my-db

# Service management  
./postgres_ai status
./postgres_ai logs
./postgres_ai restart

# Health check
./postgres_ai health
```

## 🌐 Access points

After running quickstart:

- **🚀 MAIN: Grafana Dashboard**: http://localhost:3000 (demouser/demopwd)

Technical URLs (for advanced users):
- **Demo DB**: postgresql://postgres:postgres@localhost:5432/target_database
- **Monitoring**: http://localhost:8080 (PGWatch)
- **Metrics**: http://localhost:9090 (Prometheus)

## 📖 Help

```bash
./postgres_ai help
```

## 🔑 Postgres AI access token
Get your key at [Postgres AI](https://postgres.ai) for automated report uploads and advanced analysis.

