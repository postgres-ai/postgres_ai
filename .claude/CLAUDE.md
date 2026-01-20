# postgresai

AI-native PostgreSQL observability — monitoring, health checks, and root cause analysis.

## Commands

- `/pgai:issues [id]` — Work with Issues from console.postgres.ai
- `/pgai:checkup <connection>` — Run health checks

## CLI

```bash
# Health check (no Docker required)
postgresai checkup postgresql://user@host:5432/db

# Specific check (e.g., unused indexes)
postgresai checkup --check-id H002 postgresql://...

# Full monitoring stack
postgresai mon local-install --demo
```

## Checks

| ID | Finds |
|----|-------|
| H002 | Unused indexes |
| H004 | Redundant indexes |
| F004 | Table bloat |
| K003 | Top queries |
