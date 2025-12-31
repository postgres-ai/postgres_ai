# AI DBA - PostgreSQL Health Monitor & Advisor

This project includes an AI DBA plugin for Claude Code that monitors PostgreSQL database health, analyzes issues, and proposes remediation actions.

## Quick Start

Use the `/postgresai` slash command to start an AI DBA session:

```
/postgresai
```

(alias: `/pgai`)

### Specialized Commands (pgai: namespace)

| Command | Description |
|---------|-------------|
| `/pgai:checkup <conn>` | Quick health assessment (alias: `/pgai:health`) |
| `/pgai:monitor <conn> [interval]` | Continuous monitoring loop |
| `/pgai:analyze <issue_id>` | Deep-dive issue analysis |
| `/pgai:fix-indexes` | Analyze and remediate index issues |
| `/pgai:rca <incident>` | Root cause analysis using Grafana |

## Operating Modes

1. **OBSERVE** (default) - Report findings without making changes
2. **ADVISE** - Propose solutions and wait for approval
3. **AUTO-FIX** - Execute safe, pre-approved remediations

## Architecture

### CLI Commands
The postgresai CLI provides core functionality:
- `postgresai checkup` - Express health checks
- `postgresai issues` - Issue tracking
- `postgresai mon` - Monitoring stack management

### MCP Server Tools
The MCP server exposes AI DBA tools:
- `dba_health_check` - Run health checkups
- `dba_monitoring_status` - Check monitoring stack
- `dba_monitoring_health` - Verify service health
- `dba_list_targets` - List monitored databases
- `dba_query_metrics` - Query Grafana metrics
- `dba_analyze_findings` - Analyze and categorize findings

### Health Check Categories

| ID | Category | Description |
|----|----------|-------------|
| A001-A008 | System | Version, uptime, resources |
| D004 | Monitoring | pg_stat_statements |
| F001, F004, F005 | Autovacuum | Bloat analysis |
| G001 | Performance | Memory usage |
| H001, H002, H004 | Indexes | Invalid, unused, redundant |
| K001-K008 | Queries | Time, temp, WAL analysis |
| M001-M003 | Top N | Slow query identification |
| N001 | Waits | Lock contention |

## Safety Rules

1. Never execute DROP/TRUNCATE/DELETE without explicit approval
2. Always use CONCURRENTLY for index operations
3. Log all actions to issues for audit trail
4. Test recommendations on non-production first

## Grafana Dashboards

Access at http://localhost:3000 (credentials: monitoring/[generated])

Key dashboards for RCA:
- Dashboard 1: Node performance
- Dashboard 4: Wait sampling
- Dashboard 7: Autovacuum
- Dashboard 10: Index health
- Dashboard 13: Lock waits

## Environment Variables

- `PGAI_API_KEY` - PostgresAI API key for issues
- `PGAI_FLASK_URL` - Flask backend URL (default: http://localhost:55000)
- `PGAI_API_BASE_URL` - API base URL

## Continuous Monitoring

For periodic health reviews, the AI DBA can:
1. Run health checks on interval
2. Compare with baseline
3. Report significant changes
4. Update issues automatically

Say "stop" or "pause" to exit the monitoring loop gracefully.
