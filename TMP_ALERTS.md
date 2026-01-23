# PostgreSQL Monitoring Alerts Implementation Plan

## Executive Summary

This document proposes adding configurable alerting capabilities to the postgresai monitoring stack. The system will support **20+ key PostgreSQL alerts** with both **direct alerting** (via Prometheus Alertmanager) and **console.postgres.ai integration** for issue tracking and AI-driven recommendations.

## Current State Analysis

### Existing Infrastructure

The monitoring stack already has the foundation for alerting:

1. **Victoria Metrics** (`sink-prometheus`) - Prometheus-compatible time-series DB with 2-week retention
2. **Prometheus config** (`config/prometheus/prometheus.yml`) - Has `rule_files:` section ready but commented out
3. **pgwatch** collectors - 30+ metrics already being collected (db_stats, locks, replication, etc.)
4. **Console integration** - Issue API with action items (`cli/lib/issues.ts`)
5. **Reporter** - Periodic health checks with JSON reports (`reporter/postgres_reports.py`)

### What's Missing

- No Alertmanager container
- No alert rule files
- No notification channels (email/Slack/PagerDuty)
- No console.postgres.ai alert-to-issue bridge

---

## Architecture Decision: Hybrid Approach (Both)

### Recommendation: **BOTH direct alerting AND console.postgres.ai integration**

| Approach | Pros | Cons | Use Case |
|----------|------|------|----------|
| **Direct (Alertmanager)** | Real-time, industry-standard, integrates with PagerDuty/Slack/OpsGenie | No AI analysis, stateless | Critical alerts requiring immediate action |
| **Console.postgres.ai** | AI analysis, issue tracking, action items, historical context | Higher latency (~24h reporter cycle) | Non-urgent findings, optimization recommendations |
| **Hybrid** | Best of both worlds | More complexity | Recommended for production deployments |

### Hybrid Architecture

```
                                    ┌─────────────────────────────────┐
                                    │         DIRECT PATH             │
                                    │    (Real-time critical alerts)  │
┌─────────────┐   ┌────────────┐   │   ┌──────────────┐              │
│   pgwatch   │──▶│  Victoria  │───┼──▶│ Alertmanager │──▶ Slack/PagerDuty/Email
│  collectors │   │   Metrics  │   │   └──────────────┘              │
└─────────────┘   └────────────┘   │                                 │
                        │          │         ┌─────────────────────┐ │
                        │          │    ┌───▶│ console.postgres.ai │ │
                        │          │    │    │   (Issue + AI RCA)  │ │
                        ▼          │    │    └─────────────────────┘ │
                  ┌────────────┐   │    │                            │
                  │  Reporter  │───┼────┘                            │
                  │ (periodic) │   │                                 │
                  └────────────┘   │      CONSOLE PATH               │
                                   │  (Async analysis + tracking)    │
                                   └─────────────────────────────────┘
```

---

## Proposed Alerts (20 Key Alerts)

### Category 1: Availability & Health (Critical)

| ID | Alert Name | Condition | Severity | Threshold |
|----|------------|-----------|----------|-----------|
| A001 | `PostgresDown` | Instance unreachable | critical | 0 for 1m |
| A002 | `PostgresRestarted` | `postmaster_uptime_s` reset | warning | uptime < 300s |
| A003 | `ReplicationLagCritical` | Replica lag > threshold | critical | > 5min |
| A004 | `ReplicationLagWarning` | Replica lag elevated | warning | > 1min |
| A005 | `ReplicaDisconnected` | Streaming replica down | critical | state != streaming |

### Category 2: Connection & Resource (High)

| ID | Alert Name | Condition | Severity | Threshold |
|----|------------|-----------|----------|-----------|
| C001 | `ConnectionsNearMax` | Connections approaching limit | warning | > 80% max_connections |
| C002 | `ConnectionsExhausted` | Connections at limit | critical | > 95% max_connections |
| C003 | `IdleInTransactionLong` | Long idle-in-transaction sessions | warning | > 5min duration |
| C004 | `LongRunningQuery` | Query running too long | warning | > 30min |

### Category 3: Locks & Blocking (High)

| ID | Alert Name | Condition | Severity | Threshold |
|----|------------|-----------|----------|-----------|
| L001 | `DeadlockDetected` | Deadlock occurred | warning | rate(deadlocks) > 0 |
| L002 | `LockWaitTimeout` | Lock wait exceeds threshold | warning | > 30s |
| L003 | `BlockingSessionsHigh` | Many blocked sessions | warning | > 5 blocked |

### Category 4: Storage & Disk (Medium-High)

| ID | Alert Name | Condition | Severity | Threshold |
|----|------------|-----------|----------|-----------|
| S001 | `DiskSpaceLow` | Tablespace running low | critical | < 10% free |
| S002 | `WALDiskSpaceLow` | WAL partition running low | critical | < 15% free |
| S003 | `DatabaseSizeGrowth` | Unusual database growth | warning | > 10% in 24h |
| S004 | `TempFilesExcessive` | Heavy temp file usage | warning | > 1GB/hour |

### Category 5: Performance & Efficiency (Medium)

| ID | Alert Name | Condition | Severity | Threshold |
|----|------------|-----------|----------|-----------|
| P001 | `CacheHitRatioLow` | Buffer cache hit ratio low | warning | < 95% |
| P002 | `CheckpointsTooFrequent` | Checkpoints happening too often | warning | > 10/hour |
| P003 | `VacuumNotRunning` | Autovacuum hasn't run recently | warning | > 24h |
| P004 | `XIDWraparoundRisk` | Transaction ID wraparound risk | critical | age > 1B |

### Category 6: Data Integrity (Critical)

| ID | Alert Name | Condition | Severity | Threshold |
|----|------------|-----------|----------|-----------|
| D001 | `ChecksumFailure` | Data checksum failure detected | critical | rate > 0 |
| D002 | `InvalidIndexDetected` | Invalid index exists | warning | count > 0 |

---

## Alert Configuration Schema

### YAML Configuration Format

```yaml
# config/alerts/alerts.yml
global:
  evaluation_interval: 30s
  resolve_timeout: 5m

# Notification channels
notification_channels:
  - name: slack-critical
    type: slack
    webhook_url: ${SLACK_WEBHOOK_URL}
    channel: "#postgres-alerts"
    severity_filter: [critical]

  - name: pagerduty-oncall
    type: pagerduty
    integration_key: ${PAGERDUTY_KEY}
    severity_filter: [critical]

  - name: email-team
    type: email
    smtp_host: ${SMTP_HOST}
    to: ["dba-team@company.com"]
    severity_filter: [warning, critical]

  - name: console-postgres-ai
    type: console
    api_key: ${POSTGRES_AI_API_KEY}
    base_url: https://console.postgres.ai/api/general
    create_issues: true
    generate_action_items: true

# Alert definitions with per-alert overrides
alerts:
  postgres_down:
    enabled: true
    severity: critical
    for: 1m
    labels:
      category: availability
    annotations:
      summary: "PostgreSQL instance {{ $labels.instance }} is down"
      description: "Database has been unreachable for more than 1 minute"
      runbook_url: "https://docs.postgres.ai/runbooks/postgres-down"
    channels: [slack-critical, pagerduty-oncall, console-postgres-ai]
    thresholds:
      # No threshold override - uses default behavior

  connections_near_max:
    enabled: true
    severity: warning
    for: 5m
    labels:
      category: connections
    annotations:
      summary: "Connections at {{ $value }}% of max on {{ $labels.instance }}"
    channels: [slack-critical, email-team]
    thresholds:
      warning: 80   # Percent of max_connections
      critical: 95

  replication_lag:
    enabled: true
    severity: warning
    for: 2m
    labels:
      category: replication
    thresholds:
      warning: 60    # seconds
      critical: 300  # seconds
    channels: [slack-critical, pagerduty-oncall]
```

### Environment Variable Overrides

```bash
# .env or docker-compose environment
ALERT_CONNECTIONS_NEAR_MAX_WARNING=85
ALERT_CONNECTIONS_NEAR_MAX_CRITICAL=98
ALERT_REPLICATION_LAG_WARNING=120
ALERT_REPLICATION_LAG_CRITICAL=600
ALERT_CACHE_HIT_RATIO_WARNING=90
```

---

## Implementation Plan

### Phase 1: Foundation (Week 1-2)

#### 1.1 Add Alertmanager Container

**File: `docker-compose.yml`**

```yaml
  alertmanager:
    image: prom/alertmanager:v0.27.0
    container_name: alertmanager
    cpus: 0.1
    mem_limit: 128m
    ports:
      - "${BIND_HOST:-}9093:9093"
    volumes:
      - postgres_ai_configs:/postgres_ai_configs:ro
      - alertmanager_data:/alertmanager
    command:
      - "--config.file=/postgres_ai_configs/alertmanager/alertmanager.yml"
      - "--storage.path=/alertmanager"
    depends_on:
      config-init:
        condition: service_completed_successfully
    restart: unless-stopped
```

#### 1.2 Create Alert Rules

**File: `config/prometheus/alert_rules.yml`**

```yaml
groups:
  - name: postgres_availability
    interval: 30s
    rules:
      - alert: PostgresDown
        expr: up{job="pgwatch-prometheus"} == 0
        for: 1m
        labels:
          severity: critical
          category: availability
        annotations:
          summary: "PostgreSQL instance {{ $labels.instance }} is down"
          description: "The PostgreSQL instance has been unreachable for more than 1 minute."

      - alert: PostgresRestarted
        expr: pgwatch_db_stats_postmaster_uptime_s < 300
        for: 0m
        labels:
          severity: warning
          category: availability
        annotations:
          summary: "PostgreSQL instance {{ $labels.instance }} was restarted"
          description: "Instance uptime is {{ $value }} seconds"

  - name: postgres_connections
    interval: 30s
    rules:
      - alert: ConnectionsNearMax
        expr: |
          (pgwatch_db_stats_numbackends / on(datname) pgwatch_pg_settings_max_connections) * 100 > 80
        for: 5m
        labels:
          severity: warning
          category: connections
        annotations:
          summary: "Connections at {{ printf \"%.1f\" $value }}% of max"
          description: "Database {{ $labels.datname }} is approaching connection limit"

      - alert: ConnectionsExhausted
        expr: |
          (pgwatch_db_stats_numbackends / on(datname) pgwatch_pg_settings_max_connections) * 100 > 95
        for: 1m
        labels:
          severity: critical
          category: connections

  - name: postgres_replication
    interval: 30s
    rules:
      - alert: ReplicationLagCritical
        expr: pgwatch_replication_lag_b > 50000000  # 50MB
        for: 2m
        labels:
          severity: critical
          category: replication
        annotations:
          summary: "Replication lag critical on {{ $labels.instance }}"
          description: "Replica is {{ $value | humanize1024 }}B behind primary"

      - alert: ReplicaDisconnected
        expr: pgwatch_replication_state != 1  # 1 = streaming
        for: 1m
        labels:
          severity: critical
          category: replication

  - name: postgres_locks
    interval: 30s
    rules:
      - alert: DeadlockDetected
        expr: increase(pgwatch_db_stats_deadlocks[5m]) > 0
        for: 0m
        labels:
          severity: warning
          category: locks
        annotations:
          summary: "Deadlock detected on {{ $labels.datname }}"
          description: "{{ $value }} deadlocks in the last 5 minutes"

      - alert: LongLockWait
        expr: pgwatch_locks_waiting_count > 5
        for: 1m
        labels:
          severity: warning
          category: locks

  - name: postgres_performance
    interval: 1m
    rules:
      - alert: CacheHitRatioLow
        expr: |
          (pgwatch_db_stats_blks_hit / (pgwatch_db_stats_blks_hit + pgwatch_db_stats_blks_read)) * 100 < 95
        for: 10m
        labels:
          severity: warning
          category: performance
        annotations:
          summary: "Cache hit ratio low on {{ $labels.datname }}"
          description: "Buffer cache hit ratio is {{ printf \"%.1f\" $value }}%"

      - alert: CheckpointsTooFrequent
        expr: increase(pgwatch_checkpointer_num_requested[1h]) > 10
        for: 0m
        labels:
          severity: warning
          category: performance
        annotations:
          summary: "Too many checkpoints on {{ $labels.instance }}"
          description: "{{ $value }} checkpoints in the last hour"

  - name: postgres_data_integrity
    interval: 1m
    rules:
      - alert: ChecksumFailure
        expr: increase(pgwatch_db_stats_checksum_failures[1h]) > 0
        for: 0m
        labels:
          severity: critical
          category: data_integrity
        annotations:
          summary: "Checksum failure detected on {{ $labels.datname }}"
          description: "Data corruption may have occurred"

      - alert: InvalidIndexDetected
        expr: pgwatch_db_stats_invalid_indexes > 0
        for: 5m
        labels:
          severity: warning
          category: data_integrity
        annotations:
          summary: "Invalid index detected on {{ $labels.datname }}"
          description: "{{ $value }} invalid indexes exist"

  - name: postgres_vacuum
    interval: 5m
    rules:
      - alert: XIDWraparoundRisk
        expr: pgwatch_txid_wraparound_oldest_xid_age > 1000000000
        for: 5m
        labels:
          severity: critical
          category: vacuum
        annotations:
          summary: "Transaction ID wraparound risk on {{ $labels.datname }}"
          description: "Oldest XID age is {{ $value }}. Immediate vacuum required."

      - alert: AutovacuumNotRunning
        expr: time() - pgwatch_autovacuum_last_run_epoch > 86400
        for: 1h
        labels:
          severity: warning
          category: vacuum
```

#### 1.3 Create Alertmanager Config

**File: `config/alertmanager/alertmanager.yml`**

```yaml
global:
  resolve_timeout: 5m
  smtp_smarthost: '${SMTP_HOST}:587'
  smtp_from: 'alerts@postgres.ai'
  smtp_auth_username: '${SMTP_USER}'
  smtp_auth_password: '${SMTP_PASSWORD}'

route:
  group_by: ['alertname', 'cluster', 'datname']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'default-receiver'
  routes:
    - match:
        severity: critical
      receiver: 'critical-receiver'
      continue: true
    - match:
        category: replication
      receiver: 'replication-receiver'

receivers:
  - name: 'default-receiver'
    email_configs:
      - to: '${ALERT_EMAIL}'
        send_resolved: true

  - name: 'critical-receiver'
    slack_configs:
      - api_url: '${SLACK_WEBHOOK_URL}'
        channel: '#postgres-critical'
        title: '{{ .CommonAnnotations.summary }}'
        text: '{{ .CommonAnnotations.description }}'
    pagerduty_configs:
      - service_key: '${PAGERDUTY_KEY}'
        severity: '{{ .CommonLabels.severity }}'

  - name: 'replication-receiver'
    slack_configs:
      - api_url: '${SLACK_WEBHOOK_URL}'
        channel: '#postgres-replication'

inhibit_rules:
  - source_match:
      severity: 'critical'
    target_match:
      severity: 'warning'
    equal: ['alertname', 'cluster']
```

### Phase 2: Console Integration (Week 2-3)

#### 2.1 Alert-to-Issue Bridge Service

**File: `cli/lib/alert-bridge.ts`**

```typescript
/**
 * Alert Bridge Module
 * ===================
 * Converts Alertmanager webhook payloads to console.postgres.ai issues.
 * Provides AI-driven recommendations via the console's analysis engine.
 */

import { createIssue, createActionItem, CreatedIssue } from "./issues";

export interface AlertmanagerWebhook {
  version: string;
  groupKey: string;
  status: "firing" | "resolved";
  receiver: string;
  alerts: AlertmanagerAlert[];
}

export interface AlertmanagerAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  fingerprint: string;
}

export async function processAlertWebhook(
  webhook: AlertmanagerWebhook,
  config: {
    apiKey: string;
    apiBaseUrl: string;
    orgId: number;
    projectId?: number;
  }
): Promise<CreatedIssue[]> {
  const createdIssues: CreatedIssue[] = [];

  for (const alert of webhook.alerts) {
    if (alert.status !== "firing") continue;

    const issue = await createIssue({
      apiKey: config.apiKey,
      apiBaseUrl: config.apiBaseUrl,
      orgId: config.orgId,
      projectId: config.projectId,
      title: `[Alert] ${alert.labels.alertname}: ${alert.annotations.summary}`,
      description: buildIssueDescription(alert),
      labels: [
        `severity:${alert.labels.severity}`,
        `category:${alert.labels.category}`,
        "source:alertmanager",
      ],
    });

    // Create action item based on alert type
    const actionItem = getActionItemForAlert(alert);
    if (actionItem) {
      await createActionItem({
        apiKey: config.apiKey,
        apiBaseUrl: config.apiBaseUrl,
        issueId: issue.id,
        ...actionItem,
      });
    }

    createdIssues.push(issue);
  }

  return createdIssues;
}

function buildIssueDescription(alert: AlertmanagerAlert): string {
  return `## Alert Details

**Alert:** ${alert.labels.alertname}
**Severity:** ${alert.labels.severity}
**Category:** ${alert.labels.category}
**Instance:** ${alert.labels.instance || "N/A"}
**Database:** ${alert.labels.datname || "N/A"}

## Description

${alert.annotations.description}

## Runbook

${alert.annotations.runbook_url || "No runbook available"}

---
*Auto-generated from Alertmanager at ${alert.startsAt}*
`;
}

function getActionItemForAlert(alert: AlertmanagerAlert): {
  title: string;
  description: string;
  sqlAction?: string;
} | null {
  const alertType = alert.labels.alertname;

  const actionItems: Record<string, any> = {
    ConnectionsNearMax: {
      title: "Review and optimize connection pooling",
      description: "Check for connection leaks and consider implementing PgBouncer",
      sqlAction: `SELECT count(*), state, usename FROM pg_stat_activity GROUP BY state, usename ORDER BY count DESC;`,
    },
    DeadlockDetected: {
      title: "Investigate deadlock cause",
      description: "Review recent queries and transaction patterns",
      sqlAction: `SELECT * FROM pg_stat_activity WHERE state = 'active' ORDER BY xact_start;`,
    },
    InvalidIndexDetected: {
      title: "Rebuild invalid indexes",
      description: "Identify and rebuild invalid indexes concurrently",
      sqlAction: `SELECT indexrelid::regclass, indrelid::regclass FROM pg_index WHERE NOT indisvalid;`,
    },
    CacheHitRatioLow: {
      title: "Tune shared_buffers or review query patterns",
      description: "Low cache hit ratio indicates memory pressure or inefficient queries",
    },
    XIDWraparoundRisk: {
      title: "Emergency vacuum required",
      description: "Run aggressive vacuum to prevent transaction ID wraparound",
      sqlAction: `VACUUM (VERBOSE, FREEZE);`,
    },
  };

  return actionItems[alertType] || null;
}
```

#### 2.2 Webhook Endpoint (Flask Backend)

**File: `monitoring_flask_backend/routes/alerts.py`**

```python
"""
Alert webhook endpoint for Alertmanager integration.
Forwards alerts to console.postgres.ai for issue tracking.
"""

from flask import Blueprint, request, jsonify
import requests
import os

alerts_bp = Blueprint('alerts', __name__)

CONSOLE_API_URL = os.environ.get('CONSOLE_API_URL', 'https://console.postgres.ai/api/general')
CONSOLE_API_KEY = os.environ.get('CONSOLE_API_KEY', '')
CONSOLE_ORG_ID = int(os.environ.get('CONSOLE_ORG_ID', '0'))

@alerts_bp.route('/alertmanager/webhook', methods=['POST'])
def alertmanager_webhook():
    """Receive Alertmanager webhooks and create issues in console."""
    if not CONSOLE_API_KEY:
        return jsonify({"status": "skipped", "reason": "Console API key not configured"}), 200

    webhook = request.get_json()
    created_issues = []

    for alert in webhook.get('alerts', []):
        if alert['status'] != 'firing':
            continue

        # Create issue via console API
        issue_data = {
            'title': f"[Alert] {alert['labels'].get('alertname')}: {alert['annotations'].get('summary', '')}",
            'org_id': CONSOLE_ORG_ID,
            'description': format_alert_description(alert),
            'labels': [
                f"severity:{alert['labels'].get('severity', 'unknown')}",
                f"category:{alert['labels'].get('category', 'unknown')}",
                'source:alertmanager'
            ]
        }

        try:
            resp = requests.post(
                f"{CONSOLE_API_URL}/rpc/issue_create",
                json=issue_data,
                headers={'access-token': CONSOLE_API_KEY}
            )
            if resp.ok:
                created_issues.append(resp.json())
        except Exception as e:
            print(f"Failed to create issue: {e}")

    return jsonify({
        "status": "ok",
        "issues_created": len(created_issues)
    }), 200

def format_alert_description(alert):
    return f"""## Alert Details

**Alert:** {alert['labels'].get('alertname')}
**Severity:** {alert['labels'].get('severity')}
**Instance:** {alert['labels'].get('instance', 'N/A')}
**Database:** {alert['labels'].get('datname', 'N/A')}

## Description

{alert['annotations'].get('description', 'No description')}

---
*Auto-generated from Alertmanager*
"""
```

### Phase 3: CLI & Configuration (Week 3-4)

#### 3.1 CLI Commands

**New commands for `cli/bin/postgres-ai.ts`:**

```typescript
// Alert management commands
const alertsCommand = program
  .command("alerts")
  .description("Manage monitoring alerts");

alertsCommand
  .command("list")
  .description("List configured alerts and their status")
  .option("--status <status>", "Filter by status (firing|pending|inactive)")
  .action(async (options) => {
    // Query Alertmanager API for alert status
  });

alertsCommand
  .command("silence <alertname>")
  .description("Silence an alert temporarily")
  .option("--duration <duration>", "Silence duration (e.g., 2h, 1d)", "2h")
  .option("--comment <comment>", "Reason for silencing")
  .action(async (alertname, options) => {
    // Create silence in Alertmanager
  });

alertsCommand
  .command("test <alertname>")
  .description("Test alert notification channels")
  .action(async (alertname) => {
    // Send test alert to configured channels
  });

alertsCommand
  .command("config")
  .description("Show current alert configuration")
  .option("--validate", "Validate configuration syntax")
  .action(async (options) => {
    // Display/validate alert config
  });
```

#### 3.2 User Configuration

**File: `~/.config/postgresai/alerts.yml` (user overrides)**

```yaml
# User-specific alert configuration overrides
thresholds:
  connections_near_max:
    warning: 85
    critical: 98

  replication_lag:
    warning: 120  # seconds
    critical: 600

  cache_hit_ratio:
    warning: 92

# Disable specific alerts
disabled_alerts:
  - CheckpointsTooFrequent  # We have fast storage

# Custom notification routing
notifications:
  slack:
    webhook_url: "https://hooks.slack.com/services/xxx"
    channel: "#my-team-alerts"
```

### Phase 4: Documentation & Testing (Week 4)

#### 4.1 Documentation Updates

1. **README.md** - Add alerts section to quick start
2. **docs/alerts.md** - Full alert reference and configuration guide
3. **docs/runbooks/** - Runbook for each alert type

#### 4.2 Integration Tests

```typescript
// tests/alerts.test.ts
describe("Alert Rules", () => {
  it("fires PostgresDown when instance unreachable", async () => {
    // Stop target-db container
    // Wait for evaluation interval
    // Check Alertmanager API for firing alert
  });

  it("creates console issue on critical alert", async () => {
    // Trigger critical alert
    // Verify issue created in console
    // Verify action items attached
  });
});
```

---

## File Changes Summary

### New Files to Create

| Path | Purpose |
|------|---------|
| `config/prometheus/alert_rules.yml` | Prometheus alert rules |
| `config/alertmanager/alertmanager.yml` | Alertmanager configuration |
| `config/alerts/alerts.yml` | User-configurable alert settings |
| `cli/lib/alert-bridge.ts` | Alert-to-issue bridge |
| `cli/lib/alerts.ts` | Alert management utilities |
| `monitoring_flask_backend/routes/alerts.py` | Webhook endpoint |
| `docs/alerts.md` | Alert documentation |
| `docs/runbooks/*.md` | Per-alert runbooks |

### Files to Modify

| Path | Changes |
|------|---------|
| `docker-compose.yml` | Add Alertmanager service |
| `config/prometheus/prometheus.yml` | Uncomment rule_files, add alertmanager target |
| `cli/bin/postgres-ai.ts` | Add `alerts` command group |
| `cli/lib/config.ts` | Add alert configuration loading |
| `monitoring_flask_backend/app.py` | Register alerts blueprint |

---

## Alert Thresholds Reference

### Default Thresholds (Conservative)

| Alert | Warning | Critical | Rationale |
|-------|---------|----------|-----------|
| Connections | 80% | 95% | Leave headroom for admin connections |
| Replication Lag | 60s | 300s | Balance between freshness and noise |
| Cache Hit Ratio | 95% | 90% | Standard PostgreSQL tuning target |
| Checkpoints/hour | 10 | 20 | Indicates max_wal_size tuning needed |
| Lock Wait | 30s | 60s | Long waits indicate contention |
| XID Age | 500M | 1B | Wraparound at 2B, leave margin |
| Temp Files/hour | 500MB | 2GB | Indicates work_mem tuning needed |

### Tuning Guidelines

```yaml
# Production high-traffic system
connections_near_max:
  warning: 70
  critical: 85

# Read replica with eventual consistency acceptable
replication_lag:
  warning: 300
  critical: 900

# OLAP/analytics workload (more disk reads expected)
cache_hit_ratio:
  warning: 85
  critical: 75
```

---

## Success Metrics

1. **Alert Coverage**: All 20 proposed alerts implemented and tested
2. **False Positive Rate**: < 5% of alerts are false positives after tuning
3. **Time to Alert**: Critical alerts fire within 2 minutes of condition
4. **Console Integration**: 100% of alerts create issues when configured
5. **Documentation**: All alerts have runbooks with resolution steps

---

## Timeline

| Week | Phase | Deliverables |
|------|-------|--------------|
| 1 | Foundation | Alertmanager container, basic alert rules |
| 2 | Alert Rules | All 20 alert rules, threshold configuration |
| 3 | Console Integration | Webhook endpoint, issue bridge, CLI commands |
| 4 | Polish | Documentation, testing, user config support |

---

## Open Questions

1. **Rate limiting**: Should we rate-limit alert-to-issue creation to prevent spam?
2. **Deduplication**: How long should we suppress duplicate issues for the same alert?
3. **Auto-resolution**: Should issues auto-close when alerts resolve?
4. **AI Analysis**: Should console.postgres.ai analyze metrics context when creating issues?

---

## Appendix: Available Metrics for Alerting

Based on `config/pgwatch-prometheus/metrics.yml`, these metrics are available:

### Database Stats (`pgwatch_db_stats_*`)
- `numbackends` - Active connections
- `xact_commit`, `xact_rollback` - Transaction rates
- `blks_read`, `blks_hit` - Buffer cache stats
- `tup_*` - Tuple operation counts
- `deadlocks` - Deadlock count
- `temp_files`, `temp_bytes` - Temp file usage
- `checksum_failures` - Data integrity
- `postmaster_uptime_s` - Uptime
- `invalid_indexes` - Index health

### Replication (`pgwatch_replication_*`)
- `lag_b` - Replication lag in bytes
- `state` - Streaming state

### Locks (`pgwatch_locks_*`)
- Lock counts by mode

### Checkpointer (`pgwatch_checkpointer_*`)
- `num_timed`, `num_requested` - Checkpoint counts
- `write_time`, `sync_time` - Checkpoint duration

### Background Writer (`pgwatch_bgwriter_*`)
- `buffers_*` - Buffer management stats
