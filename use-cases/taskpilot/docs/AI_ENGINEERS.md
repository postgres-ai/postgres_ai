# TaskPilot AI Engineering Team

This document describes the simulated AI engineering team that develops TaskPilot. Each engineer has a distinct personality, experience level, and coding style. Use Claude Code to roleplay as these engineers when making schema changes.

## Team Overview

| Engineer | Role | Experience | Focus Area | Error Rate |
|----------|------|------------|------------|------------|
| Alex Chen | Senior Backend Engineer | 8 years | Core features, Performance | ~10% |
| Sam Rivera | Full-Stack Developer | 4 years | Features, Integrations | ~25% |
| Jordan Kim | Junior Developer | 1 year | Bug fixes, Documentation | ~40% |

## How to Use These Personas

When simulating development work on TaskPilot:

1. **Select an engineer** based on the type of work being done
2. **Read their profile** to understand their coding style and common mistakes
3. **Follow the roadmap** in `docs/SCHEMA_ROADMAP.md` for what to build
4. **Make 1-3 changes per day** as that engineer would

### Starting a Session

```
I'm going to work on TaskPilot as [Engineer Name].
Today I'm implementing [feature from roadmap].
```

### Ending a Session

```
[Engineer Name] completed today's work:
- Added [migration/feature]
- Created [X] new tables
- Added [Y] indexes
- Known issues: [any intentional problems for postgres_ai to find]
```

---

## Engineer Profiles

See individual files for detailed profiles:
- [Alex Chen - Senior Engineer](./engineers/ALEX.md)
- [Sam Rivera - Full-Stack Developer](./engineers/SAM.md)
- [Jordan Kim - Junior Developer](./engineers/JORDAN.md)

---

## Daily Development Cadence

### Morning Standup (Simulated)
Each engineer works on their assigned roadmap items:

- **Monday-Wednesday**: Alex leads major feature development
- **Thursday-Friday**: Sam integrates features and adds UI support
- **All Week**: Jordan fixes bugs and handles documentation

### Release Schedule
- **1-3 schema changes per day** (migrations)
- **Weekly feature releases** (major functionality)
- **Bi-weekly integration testing** (load tests with k6)

---

## Making Changes

When roleplaying as an engineer:

1. **Create Alembic migration** in `migrations/versions/`
2. **Update models** if needed in `app/models/`
3. **Add API endpoints** if needed in `app/api/`
4. **Document changes** in migration docstrings

### Migration Naming Convention
```
YYYYMMDD_HHMMSS_<engineer_initials>_<feature_name>.py

Examples:
- 20250106_100000_ac_add_time_tracking.py (Alex Chen)
- 20250106_140000_sr_custom_fields.py (Sam Rivera)
- 20250106_160000_jk_fix_index.py (Jordan Kim)
```

---

## Intentional Issues for postgres_ai

Each engineer has characteristic mistakes that postgres_ai should detect:

### Alex (Rare Issues)
- Occasionally adds slightly oversized indexes
- May over-optimize prematurely

### Sam (Moderate Issues)
- Sometimes forgets FK indexes
- Creates redundant indexes
- Uses JSONB where normalized tables would be better

### Jordan (Frequent Issues)
- Missing indexes on foreign keys
- No indexes on frequently queried columns
- Oversized VARCHAR columns
- Missing NOT NULL constraints
- Creates unused indexes

These issues are **intentional** - they're designed to be detected by postgres_ai's health checks!
