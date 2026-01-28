#!/bin/bash
# /opt/postgres-ai-previews/manager/destroy.sh

set -euo pipefail

PREVIEW_BASE_DIR="/opt/postgres-ai-previews"

: "${BRANCH_SLUG:?BRANCH_SLUG is required}"

PREVIEW_DIR="${PREVIEW_BASE_DIR}/previews/${BRANCH_SLUG}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Validate BRANCH_SLUG format
if ! [[ "$BRANCH_SLUG" =~ ^[a-z0-9-]{1,63}$ ]]; then
  log "ERROR: Invalid BRANCH_SLUG format: $BRANCH_SLUG"
  exit 1
fi

# Safety check: ensure we're deleting within expected path
REAL_PREVIEW_DIR=$(realpath -m "$PREVIEW_DIR")
REAL_BASE="${PREVIEW_BASE_DIR}/previews"
if [[ "$REAL_PREVIEW_DIR" != "${REAL_BASE}/"* ]]; then
  log "SAFETY ERROR: Invalid preview directory: $REAL_PREVIEW_DIR"
  exit 1
fi

if [ ! -d "$PREVIEW_DIR" ]; then
  log "Preview directory not found: $BRANCH_SLUG"
  # Still try to clean up DNS
  "${PREVIEW_BASE_DIR}/scripts/cloudflare-dns.sh" delete "preview-${BRANCH_SLUG}" 2>/dev/null || true
  exit 0
fi

# Acquire per-preview lock (skip if held - don't block, just warn)
if ! flock -n "${PREVIEW_DIR}/.lock" true 2>/dev/null; then
  log "WARNING: Preview is locked (deploy in progress?), proceeding anyway..."
fi

log "Destroying preview: $BRANCH_SLUG"

cd "$PREVIEW_DIR"
docker compose -p "preview-${BRANCH_SLUG}" down -v --remove-orphans 2>/dev/null || true

# Delete DNS record
log "Deleting DNS record..."
"${PREVIEW_BASE_DIR}/scripts/cloudflare-dns.sh" delete "preview-${BRANCH_SLUG}" || \
  log "WARNING: DNS record deletion failed"

# Safe deletion
rm -rf "$PREVIEW_DIR"

log "Preview destroyed: $BRANCH_SLUG"
