#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

# Wrapper around the official Postgres image entrypoint.
#
# Copies optional init files from a config subdirectory into
# /docker-entrypoint-initdb.d/ and then execs docker-entrypoint.sh.
#
# Usage:
#   postgres-entrypoint.sh <config_subdir> [postgres args...]
#
# Example:
#   postgres-entrypoint.sh target-db -c shared_preload_libraries=pg_stat_statements

CONFIGS_ROOT="${PGAI_CONFIGS_ROOT:-/postgres_ai_configs}"
INITDB_DIR="${PGAI_INITDB_DIR:-/docker-entrypoint-initdb.d}"

copy_init_files() {
  local src_dir="$1"
  local pattern

  if [[ ! -d "${src_dir}" ]]; then
    return 0
  fi

  shopt -s nullglob
  for pattern in "${src_dir}"/*.sh "${src_dir}"/*.sql; do
    cp -f -- "${pattern}" "${INITDB_DIR}/"
  done
  shopt -u nullglob
}

main() {
  if [[ $# -lt 1 ]]; then
    echo "postgres-entrypoint: missing <config_subdir>" >&2
    exit 2
  fi

  local config_subdir="$1"
  shift

  copy_init_files "${CONFIGS_ROOT}/${config_subdir}"

  exec docker-entrypoint.sh postgres "$@"
}

main "$@"


