#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# Generates pgwatch sources.yml files based on instances.yaml template.
#
# Expected inputs:
# - /app/instances.yaml (mounted from ./instances.yml)
# - /postgres_ai_configs volume
#
# Output:
# - /postgres_ai_configs/pgwatch/sources.yml
# - /postgres_ai_configs/pgwatch-prometheus/sources.yml

INSTANCES_PATH="${INSTANCES_PATH:-/app/instances.yaml}"
CONFIGS_DIR="${CONFIGS_DIR:-/postgres_ai_configs}"

write_sources() {
  local sink_type="$1"
  local out_path="$2"

  {
    echo "# PGWatch Sources Configuration - ${sink_type} Instance"
    sed "s/~sink_type~/${sink_type}/g" "${INSTANCES_PATH}"
  } > "${out_path}"
}

main() {
  if [[ ! -f "${INSTANCES_PATH}" ]]; then
    echo "generate-pgwatch-sources: instances file not found: ${INSTANCES_PATH}" >&2
    exit 1
  fi

  mkdir -p -- "${CONFIGS_DIR}/pgwatch" "${CONFIGS_DIR}/pgwatch-prometheus"

  write_sources "postgresql" "${CONFIGS_DIR}/pgwatch/sources.yml"
  write_sources "prometheus" "${CONFIGS_DIR}/pgwatch-prometheus/sources.yml"

  echo "generate-pgwatch-sources: generated sources.yml files"
}

main "$@"


