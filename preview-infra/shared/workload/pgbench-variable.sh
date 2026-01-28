#!/bin/bash
# /opt/postgres-ai-previews/shared/workload/pgbench-variable.sh

set -euo pipefail

# Graceful shutdown handling
SHUTDOWN=0
trap 'SHUTDOWN=1; echo "[$(date)] Received shutdown signal, finishing current pattern..."' SIGTERM SIGINT

DB_HOST="${PGHOST:-target-db}"
DB_PORT="${PGPORT:-5432}"
DB_NAME="${PGDATABASE:-target_database}"
DB_USER="${PGUSER:-postgres}"

export PGPASSWORD="${PGPASSWORD:-postgres}"

# Wait for database to be truly ready (not just socket open)
echo "[$(date)] Waiting for database..."
until psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" >/dev/null 2>&1; do
  echo "[$(date)] Database not ready, retrying..."
  sleep 2
done
echo "[$(date)] Database ready"

# Initialize pgbench schema ONLY if not exists
if ! psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
     -c "SELECT 1 FROM pgbench_accounts LIMIT 1" >/dev/null 2>&1; then
  echo "[$(date)] Initializing pgbench schema..."
  pgbench -i -s 10 -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
else
  echo "[$(date)] pgbench schema already exists, skipping init"
fi

CONN="-h $DB_HOST -p $DB_PORT -U $DB_USER $DB_NAME"

while [ $SHUTDOWN -eq 0 ]; do
  PATTERN=$((RANDOM % 6))

  case $PATTERN in
    0) # Spike: high intensity, short duration
      echo "[$(date)] Pattern: SPIKE"
      timeout 35 pgbench -c 4 -j 2 -T 30 $CONN 2>/dev/null || true
      [ $SHUTDOWN -eq 0 ] && sleep 60
      ;;
    1) # Valley: minimal activity
      echo "[$(date)] Pattern: VALLEY"
      timeout 125 pgbench -c 1 -j 1 -T 120 -R 5 $CONN 2>/dev/null || true
      ;;
    2) # Ramp up
      echo "[$(date)] Pattern: RAMP UP"
      for clients in 1 2 3 4; do
        [ $SHUTDOWN -eq 1 ] && break
        timeout 50 pgbench -c $clients -j $clients -T 45 $CONN 2>/dev/null || true
      done
      ;;
    3) # Ramp down
      echo "[$(date)] Pattern: RAMP DOWN"
      for clients in 4 3 2 1; do
        [ $SHUTDOWN -eq 1 ] && break
        timeout 50 pgbench -c $clients -j $clients -T 45 $CONN 2>/dev/null || true
      done
      ;;
    4) # Steady medium
      echo "[$(date)] Pattern: STEADY MEDIUM"
      timeout 185 pgbench -c 2 -j 2 -T 180 $CONN 2>/dev/null || true
      ;;
    5) # Burst pattern
      echo "[$(date)] Pattern: BURST"
      for i in 1 2 3; do
        [ $SHUTDOWN -eq 1 ] && break
        timeout 25 pgbench -c 4 -j 2 -T 20 $CONN 2>/dev/null || true
        [ $SHUTDOWN -eq 0 ] && sleep 40
      done
      ;;
  esac

  if [ $SHUTDOWN -eq 0 ]; then
    PAUSE=$((30 + RANDOM % 90))
    echo "[$(date)] Pausing for ${PAUSE}s"
    sleep $PAUSE
  fi
done

echo "[$(date)] Workload generator stopped gracefully"
