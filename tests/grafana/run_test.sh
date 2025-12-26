#!/bin/bash
# E2E test runner for Grafana monitoring metrics
# This script starts the monitoring stack, waits for it to be healthy,
# and runs the e2e tests to verify metrics are being collected and displayed.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default values (can be overridden by environment variables)
TARGET_DB_URL="${TARGET_DB_URL:-postgresql://postgres:postgres@localhost:55432/target_database}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:59090}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_USER="${GRAFANA_USER:-monitor}"
GRAFANA_PASSWORD="${GRAFANA_PASSWORD:-demo}"
TEST_DBNAME="${TEST_DBNAME:-target_database}"
CLUSTER_NAME="${CLUSTER_NAME:-local}"
NODE_NAME="${NODE_NAME:-node-01}"
COLLECTION_WAIT="${COLLECTION_WAIT_SECONDS:-90}"
STARTUP_WAIT="${STARTUP_WAIT_SECONDS:-120}"

# CI mode: if set, start services and wait for health
CI_MODE="${CI_MODE:-false}"

echo "=========================================="
echo "Grafana E2E Metrics Test"
echo "=========================================="
echo ""
echo "Configuration:"
echo "  Target DB: $TARGET_DB_URL"
echo "  Prometheus URL: $PROMETHEUS_URL"
echo "  Grafana URL: $GRAFANA_URL"
echo "  Grafana User: $GRAFANA_USER"
echo "  Test DB Name: $TEST_DBNAME"
echo "  Cluster Name: $CLUSTER_NAME"
echo "  Node Name: $NODE_NAME"
echo "  Collection Wait: ${COLLECTION_WAIT}s"
echo "  CI Mode: $CI_MODE"
echo ""

# Install Python dependencies if needed
install_deps() {
    echo "Checking Python dependencies..."
    if ! python3 -c "import psycopg" 2>/dev/null; then
        echo "Installing psycopg..."
        pip3 install --quiet psycopg
    fi

    if ! python3 -c "import requests" 2>/dev/null; then
        echo "Installing requests..."
        pip3 install --quiet requests
    fi
    echo "Dependencies OK"
}

# Wait for a service to be ready
wait_for_service() {
    local url="$1"
    local name="$2"
    local max_wait="${3:-60}"
    local auth="${4:-}"

    echo "Waiting for $name at $url..."
    local waited=0
    while [ $waited -lt $max_wait ]; do
        if [ -n "$auth" ]; then
            if curl -sf -u "$auth" "$url" >/dev/null 2>&1; then
                echo "  $name is ready"
                return 0
            fi
        else
            if curl -sf "$url" >/dev/null 2>&1; then
                echo "  $name is ready"
                return 0
            fi
        fi
        sleep 5
        waited=$((waited + 5))
        echo "  Waiting... ($waited/${max_wait}s)"
    done

    echo "  ERROR: $name not ready after ${max_wait}s"
    return 1
}

# Start services in CI mode
start_services() {
    echo ""
    echo "Starting monitoring stack..."
    cd "$PROJECT_ROOT"

    # Use docker compose (v2) or docker-compose (v1)
    if command -v docker compose >/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
    else
        COMPOSE_CMD="docker-compose"
    fi

    # Start core services needed for the test
    $COMPOSE_CMD up -d target-db sink-postgres sink-prometheus pgwatch-prometheus grafana

    echo "Waiting for services to start..."
    sleep 10

    # Wait for each service
    wait_for_service "http://localhost:59090/api/v1/status/config" "Prometheus" 60
    wait_for_service "http://localhost:3000/api/health" "Grafana" 60 "${GRAFANA_USER}:${GRAFANA_PASSWORD}"

    # Wait for target-db to be ready
    echo "Waiting for target database..."
    local waited=0
    while [ $waited -lt 60 ]; do
        if PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres -d target_database -c "SELECT 1" >/dev/null 2>&1; then
            echo "  Target database is ready"
            break
        fi
        sleep 5
        waited=$((waited + 5))
        echo "  Waiting... ($waited/60s)"
    done

    echo ""
    echo "Waiting ${STARTUP_WAIT}s for initial metric collection..."
    sleep "$STARTUP_WAIT"
}

# Cleanup in CI mode
cleanup_services() {
    if [ "$CI_MODE" = "true" ]; then
        echo ""
        echo "Stopping services..."
        cd "$PROJECT_ROOT"
        if command -v docker compose >/dev/null 2>&1; then
            docker compose down -v || true
        else
            docker-compose down -v || true
        fi
    fi
}

# Main execution
main() {
    install_deps

    if [ "$CI_MODE" = "true" ]; then
        start_services
        trap cleanup_services EXIT
    fi

    echo ""
    echo "Running e2e tests..."
    echo ""

    cd "$PROJECT_ROOT"
    python3 tests/grafana/test_grafana_metrics.py \
        --target-db-url "$TARGET_DB_URL" \
        --prometheus-url "$PROMETHEUS_URL" \
        --grafana-url "$GRAFANA_URL" \
        --grafana-user "$GRAFANA_USER" \
        --grafana-password "$GRAFANA_PASSWORD" \
        --test-dbname "$TEST_DBNAME" \
        --cluster-name "$CLUSTER_NAME" \
        --node-name "$NODE_NAME" \
        --collection-wait "$COLLECTION_WAIT"
}

main "$@"
