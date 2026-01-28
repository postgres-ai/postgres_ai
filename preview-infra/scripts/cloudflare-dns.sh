#!/bin/bash
# /opt/postgres-ai-previews/scripts/cloudflare-dns.sh
# Manages DNS records via Cloudflare API

set -euo pipefail

ACTION="${1:?Usage: cloudflare-dns.sh <create|delete> <subdomain>}"
SUBDOMAIN="${2:?Usage: cloudflare-dns.sh <create|delete> <subdomain>}"

# Load credentials
source /opt/postgres-ai-previews/traefik/.env
: "${CF_DNS_API_TOKEN:?CF_DNS_API_TOKEN not set}"
: "${CF_ZONE_ID:?CF_ZONE_ID not set}"
: "${VM_PUBLIC_IP:?VM_PUBLIC_IP not set}"

FULL_NAME="${SUBDOMAIN}.pgai.watch"
API_BASE="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] cloudflare-dns: $*"; }

case "$ACTION" in
  create)
    # Check if record exists
    EXISTING=$(curl -s -X GET "${API_BASE}?name=${FULL_NAME}" \
      -H "Authorization: Bearer ${CF_DNS_API_TOKEN}" \
      -H "Content-Type: application/json" | jq -r '.result[0].id // empty')

    if [ -n "$EXISTING" ]; then
      log "Record ${FULL_NAME} already exists (ID: ${EXISTING}), updating..."
      curl -s -X PUT "${API_BASE}/${EXISTING}" \
        -H "Authorization: Bearer ${CF_DNS_API_TOKEN}" \
        -H "Content-Type: application/json" \
        --data '{
          "type": "A",
          "name": "'"${FULL_NAME}"'",
          "content": "'"${VM_PUBLIC_IP}"'",
          "ttl": 120,
          "proxied": true
        }' | jq -e '.success' > /dev/null
    else
      log "Creating DNS record: ${FULL_NAME} -> ${VM_PUBLIC_IP}"
      curl -s -X POST "${API_BASE}" \
        -H "Authorization: Bearer ${CF_DNS_API_TOKEN}" \
        -H "Content-Type: application/json" \
        --data '{
          "type": "A",
          "name": "'"${FULL_NAME}"'",
          "content": "'"${VM_PUBLIC_IP}"'",
          "ttl": 120,
          "proxied": true
        }' | jq -e '.success' > /dev/null
    fi
    log "DNS record created/updated: ${FULL_NAME}"
    ;;

  delete)
    RECORD_ID=$(curl -s -X GET "${API_BASE}?name=${FULL_NAME}" \
      -H "Authorization: Bearer ${CF_DNS_API_TOKEN}" \
      -H "Content-Type: application/json" | jq -r '.result[0].id // empty')

    if [ -n "$RECORD_ID" ]; then
      log "Deleting DNS record: ${FULL_NAME} (ID: ${RECORD_ID})"
      curl -s -X DELETE "${API_BASE}/${RECORD_ID}" \
        -H "Authorization: Bearer ${CF_DNS_API_TOKEN}" | jq -e '.success' > /dev/null
      log "DNS record deleted"
    else
      log "No DNS record found for ${FULL_NAME}, skipping"
    fi
    ;;

  *)
    echo "Unknown action: $ACTION" >&2
    exit 1
    ;;
esac
