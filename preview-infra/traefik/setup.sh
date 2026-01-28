#!/bin/bash
# /opt/postgres-ai-previews/traefik/setup.sh
# Idempotent Traefik setup script

set -euo pipefail

cd /opt/postgres-ai-previews/traefik

# Create network if not exists
docker network inspect traefik-public >/dev/null 2>&1 || \
  docker network create traefik-public

# Initialize acme.json with correct permissions
[ -f acme.json ] || (touch acme.json && chmod 600 acme.json)

# Verify .env exists
if [ ! -f .env ]; then
  echo "ERROR: .env file missing. Create it with:"
  echo "  CF_DNS_API_TOKEN=<token>"
  echo "  CF_ZONE_ID=<zone-id>"
  echo "  VM_PUBLIC_IP=<ip>"
  exit 1
fi
chmod 600 .env

# Start or recreate Traefik
docker compose up -d --force-recreate

echo "Traefik setup complete"
echo "Dashboard available via SSH tunnel: ssh -L 8080:localhost:8080 deploy@$(grep VM_PUBLIC_IP .env | cut -d= -f2)"
