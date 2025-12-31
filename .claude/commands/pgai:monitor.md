# PGAI Monitor

Continuous monitoring session that periodically checks cluster health.

## Arguments
- `$ARGUMENTS` should contain: `<connection_string> [interval_seconds]`
- Default interval: 60 seconds

## Instructions

### Phase 1: Initial Setup
1. Parse arguments to extract connection string and interval
2. Run initial health check to establish baseline
3. Store baseline findings for comparison

### Phase 2: Monitoring Loop

For each iteration:

1. **Wait for interval**
   - Sleep for the specified interval (default 60s)
   - Check if user requested stop

2. **Run health check**
```bash
postgresai checkup "$CONNECTION_STRING" --output /tmp/ai-dba-checkup-$(date +%s)
```

3. **Compare with baseline**
   - Identify new issues
   - Identify resolved issues
   - Track metric trends

4. **Report changes**
   - Only report significant changes
   - Highlight degradation
   - Note improvements

5. **Update issues**
   - Comment on relevant open issues with new data
   - Create new issues for newly detected problems

### Phase 3: Stop Handling

When the user says "stop", "pause", or "exit":
1. Save current state summary
2. List any unresolved findings
3. Offer to create issues for pending items
4. Exit the monitoring loop

### Output Format

For each check cycle, report:
```
=== Health Check Cycle #N (timestamp) ===
Status: HEALTHY | DEGRADED | CRITICAL

Changes since last check:
- [+] New issue: ...
- [-] Resolved: ...
- [~] Changed: ...

Top concerns:
1. ...
2. ...

Next check in: Xs
```

### Conversation Hooks

If the user interjects with questions during monitoring:
- Pause the loop
- Answer the question with context from recent checks
- Resume monitoring when appropriate

To exit the loop gracefully, the user can say:
- "stop monitoring"
- "pause"
- "exit loop"
