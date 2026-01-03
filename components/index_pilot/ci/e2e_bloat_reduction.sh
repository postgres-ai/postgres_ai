#!/usr/bin/env bash

set -euo pipefail

# Logging
exec > >(tee -a e2e.log) 2>&1

# Env
export PAGER=cat
DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-test_index_pilot}"
DB_USER="${POSTGRES_USER:-${DB_USER:-postgres}}"
DB_PASS="${POSTGRES_PASSWORD:-${DB_PASS:-postgres}}"

CONTROL_DB="${DB_NAME}_control"
TARGET_DB="${DB_NAME}"

export PGPASSWORD="${DB_PASS:-${POSTGRES_PASSWORD:-postgres}}"

psql_base() {
  psql --no-psqlrc -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" "$@"
}

psql_c() {
  local db="$1"
  shift
  psql_base -d "${db}" -v ON_ERROR_STOP=on -At -c "$*"
}

psql_f() {
  local db="$1"
  shift
  local file="$1"
  shift
  psql_base -d "${db}" -v ON_ERROR_STOP=on -f "${file}" "$@"
}

echo "Waiting for Postgres at ${DB_HOST}:${DB_PORT} ..."
for i in {1..120}; do
  if psql_base -d postgres -At -c "select 1" > /dev/null 2>&1; then
    echo "Postgres is up"
    break
  fi
  sleep 1
  if [[ "$i" == "120" ]]; then
    echo "Postgres did not become ready in time" >&2
    exit 1
  fi
done

echo "Creating control and target databases"
psql_c postgres "drop database if exists ${CONTROL_DB};"
psql_c postgres "drop database if exists ${TARGET_DB};"
psql_c postgres "create database ${CONTROL_DB};"
psql_c postgres "create database ${TARGET_DB};"

echo "Installing extensions in control DB"
psql_c "${CONTROL_DB}" "create extension if not exists dblink;"
psql_c "${CONTROL_DB}" "create extension if not exists postgres_fdw;"

echo "Installing pg_index_pilot into control DB"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
psql_f "${CONTROL_DB}" "${REPO_DIR}/index_pilot_tables.sql"
psql_f "${CONTROL_DB}" "${REPO_DIR}/index_pilot_functions.sql"
psql_f "${CONTROL_DB}" "${REPO_DIR}/index_pilot_fdw.sql"

echo "Setting up FDW server and registration (self-host 127.0.0.1)"
psql_c "${CONTROL_DB}" "drop server if exists index_pilot_target cascade;"
psql_c "${CONTROL_DB}" "create server index_pilot_target foreign data wrapper postgres_fdw options (host '127.0.0.1', port '${DB_PORT}', dbname '${TARGET_DB}');"
psql_c "${CONTROL_DB}" "insert into index_pilot.target_databases(database_name, host, port, fdw_server_name, enabled) values ('${TARGET_DB}', '127.0.0.1', ${DB_PORT}, 'index_pilot_target', true) on conflict (database_name) do update set host=excluded.host, port=excluded.port, fdw_server_name=excluded.fdw_server_name, enabled=true;"
psql_c "${CONTROL_DB}" "drop user mapping if exists for \"${DB_USER}\" server index_pilot_target;"
psql_c "${CONTROL_DB}" "create user mapping for \"${DB_USER}\" server index_pilot_target options (user '${DB_USER}', password '${DB_PASS}');"

echo "Testing secure FDW connectivity"
psql_c "${CONTROL_DB}" "select index_pilot._connect_securely('${TARGET_DB}'::name);"

echo "Creating e2e test data (1,000,000 rows) on target"
psql_c "${CONTROL_DB}" "do \$\$
begin
  perform index_pilot._connect_securely('${TARGET_DB}'::name);
  perform dblink_exec('${TARGET_DB}', \$db\$
    create schema if not exists e2e;
    drop table if exists e2e.ci_table cascade;
    create table e2e.ci_table(
      id bigserial primary key,
      email text,
      status text,
      created_at timestamptz default now()
    );
    insert into e2e.ci_table(email,status)
    select 'user'||g::text||'@ex.com', case when g%3=0 then 'a' else 'b' end from generate_series(1,1000000) as g;
    create index idx_e2e_email on e2e.ci_table(email);
    analyze e2e.ci_table;
  \$db\$);
end
\$\$;"

echo "Initialize baseline and snapshot"
psql_c "${CONTROL_DB}" "call index_pilot.periodic(false);"
psql_c "${CONTROL_DB}" "select index_pilot.do_force_populate_index_stats('${TARGET_DB}', 'e2e', null, null);"

echo "Lower rebuild threshold for CI to ensure reindex triggers"
psql_c "${CONTROL_DB}" "select index_pilot.set_or_replace_setting('${TARGET_DB}', null, null, null, 'index_rebuild_scale_factor', '1.05', 'CI threshold');"

echo "Induce bloat: delete ~60% rows and update some"
psql_c "${CONTROL_DB}" "do \$\$
begin
  perform index_pilot._connect_securely('${TARGET_DB}'::name);
  perform dblink_exec('${TARGET_DB}', \$db\$
    delete from e2e.ci_table where id % 5 in (0,1,2);
    update e2e.ci_table set status = 'u' where id % 10 = 0;
    analyze e2e.ci_table;
  \$db\$);
end
\$\$;"

echo "Update snapshot and measure bloat before"
psql_c "${CONTROL_DB}" "call index_pilot.periodic(false);"

BLOAT_BEFORE=$(psql_c "${CONTROL_DB}" "select coalesce(max(estimated_bloat),1.0) from index_pilot.get_index_bloat_estimates('${TARGET_DB}') where schemaname='e2e' and indexrelname='idx_e2e_email';")
echo "estimated_bloat before: ${BLOAT_BEFORE}"

echo "Run periodic real pass (reindex if above threshold)"
psql_c "${CONTROL_DB}" "call index_pilot.periodic(true,false);"

echo "Measure sizes before/after from history for our index"
read -r SIZE_BEFORE SIZE_AFTER <<< "$(psql_c "${CONTROL_DB}" "select indexsize_before, indexsize_after from index_pilot.reindex_history where datname='${TARGET_DB}' and schemaname='e2e' and indexrelname='idx_e2e_email' and status='completed' order by entry_timestamp desc limit 1;")"

if [[ -z "${SIZE_BEFORE}" || -z "${SIZE_AFTER}" ]]; then
  echo "No completed reindex record found for idx_e2e_email" >&2
  # As fallback, check current estimated bloat after
  psql_c "${CONTROL_DB}" "call index_pilot.periodic(false);"
  BLOAT_AFTER=$(psql_c "${CONTROL_DB}" "select coalesce(max(estimated_bloat),1.0) from index_pilot.get_index_bloat_estimates('${TARGET_DB}') where schemaname='e2e' and indexrelname='idx_e2e_email';")
  echo "estimated_bloat after: ${BLOAT_AFTER}"
  awk -v b1="${BLOAT_BEFORE}" -v b2="${BLOAT_AFTER}" 'BEGIN { if (b2+0 < b1+0) exit 0; else exit 1 }' || {
    echo "Bloat did not decrease (before=${BLOAT_BEFORE}, after=${BLOAT_AFTER})" >&2
    exit 1
  }
  echo "Bloat decreased based on estimates"
  exit 0
fi

echo "Index size before: ${SIZE_BEFORE} bytes"
echo "Index size after:  ${SIZE_AFTER} bytes"

awk -v a="${SIZE_AFTER}" -v b="${SIZE_BEFORE}" 'BEGIN { if (a+0 <= b+0) exit 0; else exit 1 }' || {
  echo "Index size did not shrink (before=${SIZE_BEFORE}, after=${SIZE_AFTER})" >&2
  exit 1
}

echo "Index size decreased — PASS"
