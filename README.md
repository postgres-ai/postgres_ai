# postgres_ai monitoring

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitLab](https://img.shields.io/badge/GitLab-postgres--ai%2Fpostgres__ai-orange?logo=gitlab)](https://gitlab.com/postgres-ai/postgres_ai)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-blue?logo=postgresql)](https://www.postgresql.org/)
[![CLI Coverage](https://img.shields.io/gitlab/pipeline-coverage/postgres-ai%2Fpostgres_ai?branch=main&job_name=cli%3Anode%3Atests&label=CLI%20coverage)](https://gitlab.com/postgres-ai/postgres_ai/-/pipelines)
[![Reporter Coverage](https://img.shields.io/gitlab/pipeline-coverage/postgres-ai%2Fpostgres_ai?branch=main&job_name=reporter%3Atests&label=Reporter%20coverage)](https://gitlab.com/postgres-ai/postgres_ai/-/pipelines)

**Expert-level Postgres monitoring for humans and AI systems**

Part of [PostgresAI](https://postgres.ai) — postgres_ai monitoring is an open-source component of the Self-Driving Postgres initiative, providing advanced monitoring and intelligent root cause analysis for PostgreSQL databases.

![postgres_ai monitoring](assets/postgres_ai_pic.png)

## Quick links

- **Live demo**: [demo.postgres.ai](https://demo.postgres.ai) (login: `demo` / password: `demo`)
- **Documentation**: [postgres.ai/docs](https://postgres.ai/docs)
- **Get access token**: [console.postgres.ai](https://console.postgres.ai)

## Key features

- **Top-down troubleshooting** using the Four Golden Signals (Latency, Traffic, Errors, Saturation)
- **Five expert dashboards**: Troubleshooting, Query Analysis, Single Query, Wait Events, Backups & DR
- **40+ automated health checks** based on [postgres-checkup](https://gitlab.com/postgres-ai/postgres-checkup)
- **Active Session History** — Postgres's answer to Oracle ASH
- **Dual-purpose architecture** for both human experts and AI systems
- **Hybrid storage**: Victoria Metrics for time-series + Postgres for query texts

## Architecture

- **Collection**: pgwatch v3 (by Cybertec)
- **Storage**: Victoria Metrics + PostgreSQL
- **Visualization**: Grafana with expert-designed dashboards

## Quick start

### 1. Install the CLI

```bash
npm install -g postgresai
```

### 2. Prepare your database (optional — skip for demo mode)

```bash
PGPASSWORD='admin_pass' npx postgresai prepare-db postgresql://admin@host:5432/dbname
```

### 3. Start monitoring

```bash
# Demo mode (try it out)
postgresai mon local-install --demo

# Production (with your database)
postgresai mon local-install --api-key=YOUR_TOKEN --db-url="postgresql://user:pass@host:port/db"
```

Get your access token at [console.postgres.ai](https://console.postgres.ai) → `Your org → Manage → Access tokens`

## Requirements

- Linux machine with Docker (separate from your database server)
- PostgreSQL 14–18 with `pg_stat_statements` extension
- Network access to the database(s) you want to monitor

## Management

```bash
postgresai mon status          # Check status
postgresai mon targets list    # List monitored databases
postgresai mon targets add     # Add a database
postgresai mon logs            # View logs
postgresai --help              # Full command reference
```

## Security

This solution exposes several ports (Grafana 3000, Victoria Metrics 59090, etc.). **Configure your firewall** to restrict access to trusted networks only. See the full security guide in the [documentation](https://postgres.ai/docs).

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) and visit our [GitLab repository](https://gitlab.com/postgres-ai/postgres_ai).

## License

Apache License 2.0 — see [LICENSE](LICENSE).

---

**[PostgresAI](https://postgres.ai)** — Advanced Postgres monitoring, optimization, and automation for fast-growing companies.

- [Documentation](https://postgres.ai/docs)
- [Enterprise Support](https://postgres.ai/consulting)
- [Postgres.TV](https://postgres.tv) | [Postgres FM](https://postgres.fm)
- [Report Issues](https://gitlab.com/postgres-ai/postgres_ai/-/issues)
