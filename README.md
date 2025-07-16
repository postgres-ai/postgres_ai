# Postgres AI 

A complete PostgreSQL monitoring solution with automated performance analysis and reporting.

## 🚀 Quick Start

**One command setup:**

```bash
# Download the CLI
curl -o postgres_ai https://gitlab.com/postgres-ai/postgres_ai/-/raw/main/postgres_ai && chmod +x postgres_ai

# Complete setup with demo database
./postgres_ai quickstart --demo

# Production setup with your API key
./postgres_ai quickstart --api-key=your_api_key
```

That's it! Everything is installed, configured, and running.

## 📊 What You Get

- **Grafana Dashboards** - Visual monitoring at http://localhost:3000
- **PostgreSQL Monitoring** - PGWatch with comprehensive metrics
- **Automated Reports** - Daily performance analysis
- **API Integration** - Automatic upload to PostgreSQL AI
- **Demo Database** - Ready-to-use test environment

## 🎯 Use Cases

**For Developers:**
```bash
./postgres_ai quickstart --demo
```
Get a complete monitoring setup with demo data in under 2 minutes.

**For Production:**
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

## 🔧 Management Commands

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

## 🌐 Access Points

After running quickstart:

- **Grafana**: http://localhost:3000 (admin/admin)
- **Demo DB**: postgresql://postgres:postgres@localhost:5432/target_database
- **Monitoring**: http://localhost:8080 (PGWatch)
- **Metrics**: http://localhost:9090 (Prometheus)

## 📖 Help

```bash
./postgres_ai help
```

## 🔑 API Key

Get your key at [PostgreSQL AI](https://postgres.ai) for automated report uploads and advanced analysis.
