# Postgres AI 

A complete PostgreSQL monitoring solution with automated performance analysis and reporting.

## 📋 Requirements

**Infrastructure:**
- **Linux machine** with Docker installed (separate from your database server)
- **Docker access** - the user running `postgres_ai` must have Docker permissions
- **Access (network and pg_hba)** to the PostgreSQL database(s) you want to monitor

**Database:**
- Supports PostgreSQL versions 14-17
- **pg_stat_statements extension must be created** for db used for connection

## ⚠️ Security Notice

**WARNING: Security is your responsibility!**

This monitoring solution exposes several ports that **MUST** be properly firewalled:
- **Port 3000** (Grafana) - Contains sensitive database metrics and dashboards
- **Port 58080** (PGWatch Postgres) - Database monitoring interface  
- **Port 58089** (PGWatch Prometheus) - Database monitoring interface
- **Port 59090** (Prometheus) - Metrics storage and queries
- **Port 59091** (PGWatch Prometheus endpoint) - Metrics collection
- **Port 55000** (Flask API) - Backend API service
- **Port 55432** (Demo DB) - When using `--demo` option
- **Port 55433** (Metrics DB) - PostgreSQL metrics storage

**Configure your firewall to:**
- Block public access to all monitoring ports
- Allow access only from trusted networks/IPs
- Use VPN or SSH tunnels for remote access

Failure to secure these ports may expose sensitive database information!

## 🚀 Quick start

Create a new DB user in database to be monitored (skip this if you want just to check out `postgres_ai` monitoring with a synthetic `demo` database):
```sql
-- Create a user for Postgres AI monitoring
begin
create user postgres_ai_mon with password '<password>';

grant connect on database <database_name> to postgres_ai_mon;

grant pg_monitor to postgres_ai_mon;
grant select on pg_stat_statements to postgres_ai_mon;
grant select on pg_stat_database to postgres_ai_mon;
grant select on pg_stat_user_tables to postgres_ai_mon;

-- Create a public view for pg_statistic access (required for bloat metrics on user schemas)
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

grant select on public.pg_statistic to pg_monitor;
alter user postgres_ai_mon set search_path = "$user", public, pg_catalog;
commit
```

**One command setup:**

```bash
# Download the CLI
curl -o postgres_ai https://gitlab.com/postgres-ai/postgres_ai/-/raw/main/postgres_ai \
  && chmod +x postgres_ai
```

Now, start it and wait for a few minutes. To obtain Postgres AI access token for your organization visit https://console.postgres.ai (`Your org name → Manage → Access tokens`):

```bash
# Production setup with your Access token
./postgres_ai quickstart --api-key=your_access_token
```
**Note:** You can also add your database instance in the same command:
```bash
./postgres_ai quickstart --api-key=your_access_token --add-instance="postgresql://user:pass@host:port/db"
```

Or if you want to just check out how it works:
```bash
# Complete setup with demo database
./postgres_ai quickstart --demo
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
- **Demo DB**: postgresql://postgres:postgres@localhost:55432/target_database
- **Monitoring**: http://localhost:58080 (PGWatch)
- **Metrics**: http://localhost:59090 (Prometheus)

## 📖 Help

```bash
./postgres_ai help
```

## 🔑 Postgres AI access token
Get your key at [Postgres AI](https://postgres.ai) for automated report uploads and advanced analysis.

