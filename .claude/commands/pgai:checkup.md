# PGAI Checkup

> Alias: `/pgai:health`

Quick health assessment of a PostgreSQL cluster.

## Instructions

1. First check if the monitoring stack is running:
```bash
postgresai mon health --wait 5
```

2. If a database connection string is provided as `$ARGUMENTS`, run express checkup:
```bash
postgresai checkup "$ARGUMENTS"
```

3. If no connection provided but monitoring is running, check the monitored targets:
```bash
postgresai mon targets list
```

4. Parse the checkup output and summarize findings by severity:
   - **Critical**: Requires immediate attention
   - **High**: Should be addressed soon
   - **Medium**: Plan to address
   - **Low**: Informational

5. For each HIGH or CRITICAL finding, suggest:
   - Root cause
   - Remediation steps
   - Expected impact of fix

Report findings in a structured format suitable for creating issues.
