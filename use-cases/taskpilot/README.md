# TaskPilot - Linear Clone for Self-Driving Postgres Testing

**A realistic SaaS issue tracker designed as a playground for postgres_ai monitoring tools**

TaskPilot is a full-featured Linear/Jira clone built specifically to test and demonstrate the Self-Driving Postgres initiative. It provides a realistic multi-tenant SaaS environment with continuous data growth, schema changes, and workload patterns typical of production systems.

## Purpose

This playground enables testing of:
- **postgres_ai monitoring** - Real-time metrics and dashboards
- **Checkup reports** - Automated health checks (A001-N001)
- **pg_index_pilot** - Automated index recommendations
- **Schema migration analysis** - Detecting problematic migrations
- **Bloat detection** - Frequent updates create realistic bloat patterns
- **Query optimization** - Various query patterns requiring index tuning

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              TaskPilot                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                │
│  │   FastAPI   │────▶│  SQLAlchemy │────▶│  PostgreSQL │                │
│  │   Backend   │     │     ORM     │     │   Database  │                │
│  └─────────────┘     └─────────────┘     └─────────────┘                │
│         │                                       │                        │
│         │                                       │                        │
│         ▼                                       ▼                        │
│  ┌─────────────┐                        ┌─────────────┐                 │
│  │    k6       │                        │ postgres_ai │                 │
│  │  Load Test  │                        │  Monitoring │                 │
│  └─────────────┘                        └─────────────┘                 │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                 AI Engineering Team (Claude Code)                │    │
│  │  • 3 engineer personas with different skill levels              │    │
│  │  • 12-week schema roadmap (1-3 changes per day)                 │    │
│  │  • Intentional issues for postgres_ai to detect                 │    │
│  │  • See docs/AI_ENGINEERS.md for persona details                 │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Tech Stack

### Backend
| Component | Technology | Rationale |
|-----------|------------|-----------|
| Framework | **Python 3.12 + FastAPI** | Typical SaaS stack, async support, great ORM integration |
| ORM | **SQLAlchemy 2.0** | Modern async support, realistic migration patterns |
| Migrations | **Alembic** | Industry standard, generates realistic DDL |
| API Docs | **OpenAPI/Swagger** | Auto-generated from FastAPI |
| Task Queue | **Celery + Redis** | Background jobs (notifications, reports) |

### Database
| Component | Technology | Rationale |
|-----------|------------|-----------|
| Primary DB | **PostgreSQL 16** | Target for postgres_ai testing |
| Extensions | `pg_stat_statements`, `pg_trgm`, `btree_gin` | Realistic production setup |
| Connection | **asyncpg** via SQLAlchemy | High-performance async driver |

### Load Testing
| Component | Technology | Rationale |
|-----------|------------|-----------|
| Load Generator | **k6** | Modern, scriptable, realistic user simulation |
| Scenarios | JavaScript | Configurable workload patterns |

### Infrastructure
| Component | Technology | Rationale |
|-----------|------------|-----------|
| Container | **Docker Compose** | Easy local development and CI |
| Monitoring | **postgres_ai** | What we're testing! |

## Database Schema

### Entity Relationship Diagram

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│   organizations  │       │      users       │       │      teams       │
├──────────────────┤       ├──────────────────┤       ├──────────────────┤
│ id (PK)          │◄──────│ organization_id  │       │ id (PK)          │
│ name             │       │ id (PK)          │◄──┐   │ organization_id  │
│ slug             │       │ email            │   │   │ name             │
│ plan_type        │       │ name             │   │   │ slug             │
│ created_at       │       │ avatar_url       │   │   │ created_at       │
│ settings (JSONB) │       │ preferences      │   │   └──────────────────┘
└──────────────────┘       │ created_at       │   │            │
                           └──────────────────┘   │            │
                                    │             │            ▼
                                    │             │   ┌──────────────────┐
                                    ▼             │   │   team_members   │
                           ┌──────────────────┐   │   ├──────────────────┤
                           │     projects     │   │   │ team_id (FK)     │
                           ├──────────────────┤   │   │ user_id (FK)     │
                           │ id (PK)          │   │   │ role             │
                           │ organization_id  │   │   └──────────────────┘
                           │ team_id (FK)     │   │
                           │ name             │   │
                           │ key (e.g., "ENG")│   │
                           │ description      │   │
                           │ status           │   │
                           │ created_at       │   │
                           └──────────────────┘   │
                                    │             │
        ┌───────────────────────────┼─────────────┤
        │                           │             │
        ▼                           ▼             │
┌──────────────────┐       ┌──────────────────┐   │
│      cycles      │       │      issues      │   │
├──────────────────┤       ├──────────────────┤   │
│ id (PK)          │◄──────│ cycle_id (FK)    │   │
│ project_id (FK)  │       │ id (PK)          │   │
│ name             │       │ project_id (FK)  │   │
│ start_date       │       │ number           │   │
│ end_date         │       │ title            │   │
│ status           │       │ description      │   │
└──────────────────┘       │ status           │   │
                           │ priority         │   │
                           │ assignee_id (FK) │───┘
                           │ reporter_id (FK) │───┘
                           │ estimate         │
                           │ due_date         │
                           │ created_at       │
                           │ updated_at       │
                           │ metadata (JSONB) │
                           └──────────────────┘
                                    │
        ┌───────────────┬───────────┼───────────┬─────────────────┐
        │               │           │           │                 │
        ▼               ▼           ▼           ▼                 ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   comments   │ │ issue_labels │ │ attachments  │ │ activity_log │ │ issue_links  │
├──────────────┤ ├──────────────┤ ├──────────────┤ ├──────────────┤ ├──────────────┤
│ id (PK)      │ │ issue_id(FK) │ │ id (PK)      │ │ id (PK)      │ │ id (PK)      │
│ issue_id(FK) │ │ label_id(FK) │ │ issue_id(FK) │ │ issue_id(FK) │ │ source_id    │
│ user_id(FK)  │ └──────────────┘ │ user_id(FK)  │ │ user_id(FK)  │ │ target_id    │
│ body         │        │         │ filename     │ │ action       │ │ link_type    │
│ created_at   │        ▼         │ file_size    │ │ changes      │ └──────────────┘
│ updated_at   │ ┌──────────────┐ │ content_type │ │ created_at   │
│ is_internal  │ │    labels    │ │ storage_key  │ └──────────────┘
└──────────────┘ ├──────────────┤ │ created_at   │
                 │ id (PK)      │ └──────────────┘
                 │ project_id   │
                 │ name         │
                 │ color        │
                 │ description  │
                 └──────────────┘

┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  notifications   │       │     webhooks     │       │   api_tokens     │
├──────────────────┤       ├──────────────────┤       ├──────────────────┤
│ id (PK)          │       │ id (PK)          │       │ id (PK)          │
│ user_id (FK)     │       │ organization_id  │       │ user_id (FK)     │
│ type             │       │ url              │       │ name             │
│ data (JSONB)     │       │ events[]         │       │ token_hash       │
│ read_at          │       │ secret           │       │ scopes[]         │
│ created_at       │       │ active           │       │ last_used_at     │
└──────────────────┘       └──────────────────┘       │ expires_at       │
                                                       └──────────────────┘
```

### Tables Summary

| Table | Purpose | Growth Pattern | Bloat Potential |
|-------|---------|----------------|-----------------|
| `organizations` | Multi-tenant root | Slow (new signups) | Low |
| `users` | User accounts | Slow | Low |
| `teams` | Team groupings | Slow | Low |
| `projects` | Issue containers | Slow | Low |
| `issues` | Core work items | Medium | **High** (status updates) |
| `comments` | Discussion threads | **Fast** | Medium |
| `activity_log` | Audit trail | **Very Fast** | Low (insert-only) |
| `labels` | Categorization | Slow | Low |
| `issue_labels` | M:N relationship | Medium | Medium |
| `attachments` | File metadata | Medium | Low |
| `notifications` | User notifications | **Fast** | **High** (mark as read) |
| `webhooks` | Integration hooks | Slow | Low |
| `api_tokens` | API authentication | Slow | Low |
| `cycles` | Sprint-like periods | Slow | Low |
| `issue_links` | Issue relationships | Medium | Low |

## Data Size Strategy

### Initial Seeding (10 GiB)

```
Organizations:     100  (~10 KB each)
Users:           5,000  (~1 KB each)
Teams:             500  (~1 KB each)
Projects:        1,000  (~2 KB each)
Issues:        500,000  (~5 KB each = 2.5 GB)
Comments:    2,000,000  (~2 KB each = 4 GB)
Activity Log: 3,000,000  (~1 KB each = 3 GB)
Attachments:    50,000  (~500 bytes metadata)
Labels:          5,000  (~200 bytes)
Notifications: 500,000  (~500 bytes)
─────────────────────────────────────────
Total:          ~10 GiB
```

### Weekly Growth (~10 GiB/week)

| Source | Daily Volume | Weekly Volume | Size |
|--------|--------------|---------------|------|
| New Issues | 10,000 | 70,000 | ~350 MB |
| New Comments | 50,000 | 350,000 | ~700 MB |
| Activity Logs | 200,000 | 1,400,000 | ~1.4 GB |
| Issue Updates | 100,000 | 700,000 | (bloat) ~500 MB |
| Notifications | 100,000 | 700,000 | ~350 MB |
| Attachments | 5,000 | 35,000 | ~3 GB (blob data) |
| **Bloat from updates** | - | - | ~3 GB |
| **Total Weekly** | - | - | **~10 GiB** |

## AI Engineer Team

Three simulated AI engineers who make schema changes according to a roadmap:

### Team Members

| Engineer | Persona | Tendency |
|----------|---------|----------|
| **Alex** | Senior Backend | Makes solid changes, occasionally forgets indexes |
| **Sam** | Mid-level Full-stack | Sometimes creates suboptimal migrations |
| **Jordan** | Junior Backend | Learning, makes typical beginner mistakes |

### Change Types (for postgres_ai to detect)

1. **Good changes** - Proper indexes, well-designed schemas
2. **Missing indexes** - New columns queried without indexes
3. **Redundant indexes** - Creating indexes that overlap with existing ones
4. **Blocking migrations** - DDL that could cause lock issues
5. **Data type changes** - ALTER COLUMN that triggers table rewrite
6. **Bloat-inducing patterns** - Frequent updates without proper maintenance

## Development Roadmap

See [docs/AI_ENGINEER_ROADMAP.md](docs/AI_ENGINEER_ROADMAP.md) for the complete 12-week roadmap of schema changes.

### Week 1-2: Initial Features
- Add time tracking to issues
- Add custom fields (JSONB)
- Implement issue templates

### Week 3-4: Search & Performance
- Add full-text search (tsvector)
- Performance indexes
- Query optimization

### Week 5-6: Advanced Features
- Recurring issues
- Issue automation rules
- SLA tracking

### Week 7-8: Integration Features
- Webhook improvements
- API rate limiting tables
- External sync status

### Week 9-10: Analytics
- Reporting tables
- Aggregation materialized views
- Dashboard metrics

### Week 11-12: Scale Improvements
- Table partitioning for activity_log
- Archive strategies
- Read replica optimization

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Python 3.12+
- Node.js 18+ (for k6)
- postgres_ai CLI installed

### 1. Start the Stack

```bash
cd use-cases/taskpilot
docker compose up -d
```

### 2. Initialize Database

```bash
# Run migrations
alembic upgrade head

# Seed initial data (10 GiB)
python scripts/seed/initial_seed.py
```

### 3. Start Load Testing

```bash
# Start k6 with standard workload
k6 run scripts/k6/workload.js
```

### 4. Connect postgres_ai Monitoring

```bash
postgresai mon targets add "postgresql://taskpilot:taskpilot@localhost:5433/taskpilot"
```

### 5. Start AI Engineers

```bash
# Run the AI engineer simulator (makes 1-3 schema changes daily)
python scripts/ai-engineers/engineer_simulator.py
```

## Configuration

### Environment Variables

```bash
# Database
DATABASE_URL=postgresql://taskpilot:taskpilot@localhost:5433/taskpilot

# App
APP_ENV=development
SECRET_KEY=your-secret-key

# Load Testing
K6_VUS=50              # Virtual users
K6_DURATION=1h         # Test duration
K6_GROWTH_RATE=1.1     # Data growth multiplier

# AI Engineers
ENGINEER_CHANGES_PER_DAY=2
ENGINEER_ERROR_RATE=0.2  # 20% chance of problematic change
```

## Monitoring Integration

### Metrics to Watch

| Metric | Why It Matters |
|--------|----------------|
| `pg_stat_user_tables.n_dead_tup` | Bloat from issue updates |
| `pg_stat_statements.calls` | Query frequency patterns |
| `pg_stat_statements.mean_time` | Slow queries after migrations |
| `pg_locks` | Lock contention during DDL |
| `pg_stat_activity` | Long-running queries |

### Expected Alerts

The AI engineers will intentionally create situations that trigger:
- **H002 (Unused indexes)** - Redundant indexes created
- **H004 (Redundant indexes)** - Overlapping index patterns
- **F004 (Heap bloat)** - From frequent issue updates
- **F005 (Index bloat)** - From update patterns
- **K003 (Slow queries)** - Missing indexes

## Directory Structure

```
use-cases/taskpilot/
├── README.md                    # This file
├── docker-compose.yml           # Full stack setup
├── pyproject.toml              # Python dependencies
├── alembic.ini                 # Migration config
├── app/
│   ├── __init__.py
│   ├── main.py                 # FastAPI application
│   ├── config.py               # Configuration
│   ├── api/                    # API routes
│   │   ├── issues.py
│   │   ├── projects.py
│   │   ├── comments.py
│   │   └── ...
│   ├── models/                 # SQLAlchemy models
│   │   ├── base.py
│   │   ├── organization.py
│   │   ├── user.py
│   │   ├── issue.py
│   │   └── ...
│   ├── schemas/                # Pydantic schemas
│   │   ├── issue.py
│   │   └── ...
│   └── services/               # Business logic
│       ├── issue_service.py
│       └── ...
├── migrations/
│   ├── env.py
│   └── versions/              # Alembic migrations
├── scripts/
│   ├── seed/                  # Data seeding
│   │   ├── initial_seed.py
│   │   └── continuous_growth.py
│   ├── k6/                    # Load testing
│   │   ├── workload.js
│   │   ├── scenarios/
│   │   └── utils.js
│   └── ai-engineers/          # Schema change simulator
│       ├── engineer_simulator.py
│       ├── engineers/
│       │   ├── alex.py
│       │   ├── sam.py
│       │   └── jordan.py
│       └── changes/
├── docs/
│   ├── AI_ENGINEER_ROADMAP.md
│   ├── SCHEMA.md
│   └── WORKLOAD_PATTERNS.md
└── config/
    └── settings.yaml
```

## License

This project is part of postgres_ai and is licensed under Apache 2.0.

## Contributing

See the main [postgres_ai contributing guide](../../CONTRIBUTING.md).
