#!/bin/bash
# /opt/postgres-ai-previews/manager/cleanup-ttl.sh
# Cron: */30 * * * * /opt/postgres-ai-previews/manager/cleanup-ttl.sh >> /var/log/preview-cleanup.log 2>&1

set -euo pipefail

PREVIEW_BASE_DIR="/opt/postgres-ai-previews"
PREVIEW_BASE="${PREVIEW_BASE_DIR}/previews"
TTL_SECONDS=$((3 * 24 * 60 * 60))  # 3 days
NOW=$(date +%s)
GLOBAL_LOCK="${PREVIEW_BASE_DIR}/manager/.global.lock"
DISK_PRUNE_THRESHOLD=80  # Prune only if disk usage > 80%

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "Starting cleanup check..."

# Use nullglob to handle empty directory
shopt -s nullglob
PREVIEW_DIRS=("${PREVIEW_BASE}"/*/)
shopt -u nullglob

if [ ${#PREVIEW_DIRS[@]} -eq 0 ]; then
  log "No previews to check"
else
  for preview_dir in "${PREVIEW_DIRS[@]}"; do
    state_file="${preview_dir}state.json"
    [ -f "$state_file" ] || continue

    branch_slug=$(basename "$preview_dir")

    # Skip if locked (deploy in progress)
    if ! flock -n "${preview_dir}.lock" true 2>/dev/null; then
      log "Skipping ${branch_slug}: locked"
      continue
    fi

    updated_at=$(jq -r '.updated_at' "$state_file" 2>/dev/null || echo "")

    if [ -z "$updated_at" ]; then
      log "WARNING: No updated_at in $state_file, skipping"
      continue
    fi

    updated_ts=$(date -d "$updated_at" +%s 2>/dev/null || echo 0)
    age=$((NOW - updated_ts))

    if [ $age -gt $TTL_SECONDS ]; then
      log "Cleaning stale preview: $branch_slug (age: $((age/86400)) days)"

      # Safety check
      REAL_DIR=$(realpath -m "$preview_dir")
      if [[ "$REAL_DIR" != "${PREVIEW_BASE}/"* ]]; then
        log "SAFETY ERROR: Invalid path: $preview_dir"
        continue
      fi

      cd "$preview_dir"
      docker compose -p "preview-${branch_slug}" down -v --remove-orphans 2>/dev/null || true

      # Delete DNS record
      "${PREVIEW_BASE_DIR}/scripts/cloudflare-dns.sh" delete "preview-${branch_slug}" 2>/dev/null || true

      rm -rf "$preview_dir"
      log "Removed: $branch_slug"
    fi
  done
fi

# =============================================================================
# CONDITIONAL DOCKER CLEANUP (only if disk > threshold)
# =============================================================================
exec 200>"$GLOBAL_LOCK"
if flock -n 200; then
  DISK_USAGE=$(df "${PREVIEW_BASE_DIR}" | awk 'NR==2 {print $5}' | tr -d '%')

  if [ "$DISK_USAGE" -gt "$DISK_PRUNE_THRESHOLD" ]; then
    log "Disk usage ${DISK_USAGE}% > ${DISK_PRUNE_THRESHOLD}%, running Docker cleanup..."
    docker image prune -af --filter "until=72h" 2>/dev/null || true
    # Don't prune volumes - they belong to running previews
    log "Docker cleanup complete"
  else
    log "Disk usage ${DISK_USAGE}% <= ${DISK_PRUNE_THRESHOLD}%, skipping prune"
  fi
  flock -u 200
fi

log "Cleanup complete"
