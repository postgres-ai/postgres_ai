# Security Setup Guide

## Overview

This document explains how to properly configure environment variables for secure deployment of PostgresAI.

**IMPORTANT:** As of the latest update, all hardcoded credentials have been removed from the codebase and replaced with environment variables. You **MUST** configure these variables before deploying.

## Quick Start

1. **Copy the example environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` and replace all default passwords:**
   ```bash
   nano .env  # or use your preferred editor
   ```

3. **Verify `.env` is not tracked by git:**
   ```bash
   git status  # .env should NOT appear in the output
   ```

4. **Start the services:**
   ```bash
   docker-compose up -d
   ```

## Environment Variables Reference

### PostgreSQL Target Database
The database being monitored.

```bash
POSTGRES_USER=postgres              # Default superuser
POSTGRES_PASSWORD=changeme          # ⚠️  CHANGE THIS!
POSTGRES_DB=target_database         # Database name
```

### PostgreSQL Sink Database
Stores monitoring metrics and query texts.

```bash
SINK_POSTGRES_USER=postgres         # Sink database user
SINK_POSTGRES_PASSWORD=changeme     # ⚠️  CHANGE THIS!
SINK_POSTGRES_DB=postgres           # Sink database name
```

### Monitoring Users

#### Sink Database Monitoring User
User that PGWatch uses to write metrics to the sink database.

```bash
PGWATCH_MONITOR_USER=pgwatch
PGWATCH_MONITOR_PASSWORD=changeme_pgwatch_password  # ⚠️  CHANGE THIS!
```

#### Target Database Monitoring User
User that collects metrics from the target database.

```bash
TARGET_MONITOR_USER=monitor
TARGET_MONITOR_PASSWORD=changeme_monitor_password   # ⚠️  CHANGE THIS!
```

### Grafana Configuration

```bash
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=changeme_admin_password  # ⚠️  CHANGE THIS!
GF_SECURITY_ADMIN_EMAIL=admin@localhost
```

### Flask API Configuration

```bash
FLASK_ENV=production                # production or development
FLASK_DEBUG=false                   # Never set to true in production!
PROMETHEUS_URL=http://sink-prometheus:9090

# API Security
API_KEYS=key1,key2,key3            # ⚠️  CHANGE THIS! Comma-separated API keys
ALLOWED_ORIGINS=http://localhost:3000  # CORS allowed origins
```

### PostgresAI Platform (Optional)
Only needed if using PostgresAI platform features.

```bash
POSTGRES_AI_API_KEY=your_api_key_here
POSTGRES_AI_PROJECT=your_project_name
```

## Password Security Best Practices

### 1. Use Strong Passwords
Generate secure passwords using:

```bash
# Linux/macOS
openssl rand -base64 20

# Or using pwgen
pwgen -s 20 1
```

### 2. Different Passwords for Each Service
**DO NOT** reuse passwords across different services!

```bash
# ❌ BAD - Same password for everything
POSTGRES_PASSWORD=mypassword123
SINK_POSTGRES_PASSWORD=mypassword123

# ✅ GOOD - Unique passwords
POSTGRES_PASSWORD=x8K3m9Qp2nF7vL4zR1wY
SINK_POSTGRES_PASSWORD=A5nT2jK8xM9pQ3wR6vL7
```

### 3. Never Commit .env to Version Control

The `.env` file is already in `.gitignore`, but verify:

```bash
# Check git status
git status

# If .env appears, remove it from tracking
git rm --cached .env
git commit -m "Remove .env from tracking"
```

### 4. Rotate Passwords Regularly

Create a password rotation schedule:
- Production: Every 90 days
- Development: Every 6 months
- After any security incident: Immediately

## File Template System

### How It Works

1. **Template Files** (committed to git):
   - `config/sink-postgres/init-template.sql`
   - `config/target-db/init-template.sql`
   - `.env.example`

2. **Generated Files** (NOT committed to git):
   - `config/sink-postgres/init.sql` - Auto-generated from template
   - `config/target-db/init.sql` - Auto-generated from template
   - `.env` - Created by you from `.env.example`

3. **The `init-sql-generator` Service**:
   - Runs before PostgreSQL containers start
   - Reads template files
   - Substitutes environment variables
   - Generates final SQL init scripts

### Making Changes

To modify database initialization:

1. **Edit the template file**, NOT the generated file:
   ```bash
   # ✅ CORRECT
   nano config/sink-postgres/init-template.sql

   # ❌ WRONG - This file is auto-generated!
   nano config/sink-postgres/init.sql
   ```

2. **Rebuild the containers:**
   ```bash
   docker-compose down
   docker-compose up -d
   ```

## Troubleshooting

### Problem: Services fail to start

**Check environment variables:**
```bash
# View what docker-compose sees
docker-compose config

# Check if .env file exists
ls -la .env
```

### Problem: Authentication failures

**Verify credentials match:**
1. Check `.env` file
2. Check generated `config/*/init.sql` files
3. Check `instances.yml` connection string

### Problem: .env file ignored

**Check .gitignore:**
```bash
cat .gitignore | grep .env
```

Should show:
```
.env
.env.local
.env.*.local
```

## Production Deployment

### Additional Security Measures

1. **Use Docker Secrets** (Docker Swarm):
   ```yaml
   secrets:
     postgres_password:
       external: true
   services:
     target-db:
       secrets:
         - postgres_password
   ```

2. **Use External Secret Management**:
   - HashiCorp Vault
   - AWS Secrets Manager
   - Azure Key Vault
   - Google Secret Manager

3. **Enable SSL/TLS**:
   - PostgreSQL SSL connections
   - HTTPS for Grafana
   - HTTPS for Flask API

4. **Network Isolation**:
   ```yaml
   networks:
     frontend:
       internal: false
     backend:
       internal: true
   ```

5. **Restrict Port Exposure**:
   ```yaml
   # Don't expose database ports publicly
   ports:
     - "127.0.0.1:5432:5432"  # Only localhost
   ```

## Audit and Compliance

### Password Change Audit Log

Keep a record of password changes:

```bash
# Add to your operations log
echo "$(date): Rotated POSTGRES_PASSWORD - User: $(whoami)" >> /var/log/postgres_ai_audit.log
```

### Regular Security Checks

```bash
# Check for exposed secrets
git log -p | grep -i password
docker-compose config | grep -i password

# Scan for vulnerabilities
docker scan postgres:15
```

## Migration from Hardcoded Credentials

If you're upgrading from an older version with hardcoded credentials:

1. **Stop all services:**
   ```bash
   docker-compose down -v  # -v removes volumes
   ```

2. **Create `.env` file:**
   ```bash
   cp .env.example .env
   # Edit .env with your passwords
   ```

3. **Remove old data volumes** (⚠️  This deletes data!):
   ```bash
   docker volume rm postgres_ai_target_db_data
   docker volume rm postgres_ai_sink_postgres_data
   docker volume rm postgres_ai_grafana_data
   docker volume rm postgres_ai_prometheus_data
   ```

4. **Start with fresh configuration:**
   ```bash
   docker-compose up -d
   ```

## Support

For security issues or questions:
- Open an issue on GitHub: https://github.com/anthropics/postgres_ai/issues
- Include relevant logs (⚠️  **NEVER** include passwords in issues!)

---

**Last Updated:** 2025-09-29
**Version:** 2.0 (Environment Variable Migration)