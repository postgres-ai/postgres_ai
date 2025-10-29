#!/bin/bash
# E2E tests for postgres_ai CLI (Node.js)
# Usage: ./tests/e2e.cli.sh

set -e

CLI_CMD="node ./cli/bin/postgres-ai.js"

echo "=== Testing service commands ==="
$CLI_CMD check || true
$CLI_CMD config || true
$CLI_CMD update-config
$CLI_CMD start
sleep 10
$CLI_CMD status
$CLI_CMD logs --tail 5 grafana || true
$CLI_CMD health --wait 60 || true

echo ""
echo "=== Testing instance commands ==="
$CLI_CMD list-instances
$CLI_CMD add-instance "postgresql://monitor:monitor_pass@target-db:5432/target_database" ci-test
$CLI_CMD list-instances | grep -q ci-test
sleep 5
$CLI_CMD test-instance ci-test || true
$CLI_CMD remove-instance ci-test

echo ""
echo "=== Testing API key commands ==="
$CLI_CMD add-key "test_api_key_12345"
$CLI_CMD show-key | grep -q "test_api"
$CLI_CMD remove-key

echo ""
echo "=== Testing Grafana commands ==="
$CLI_CMD show-grafana-credentials
$CLI_CMD generate-grafana-password
$CLI_CMD show-grafana-credentials

echo ""
echo "=== Testing service management ==="
$CLI_CMD restart grafana
sleep 3
$CLI_CMD status
$CLI_CMD stop
$CLI_CMD clean || true

echo ""
echo "✓ All E2E tests passed"

