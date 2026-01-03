#!/usr/bin/env bash
set -Eeuo pipefail

# Run the reporter on the host against the Docker Compose stack.
#
# Defaults:
# - Prometheus/VictoriaMetrics: http://127.0.0.1:59090
# - Postgres sink: postgresql://pgwatch@127.0.0.1:55433/measurements
# - Output directory: ./dev_reports/dev_report_<UTC timestamp>/
#   (one JSON file per check, e.g. A002.json, K003.json, ...)
#
# Overrides (env vars):
# - PROMETHEUS_URL
# - POSTGRES_SINK_URL
# - OUTPUT_DIR
# - EXTRA_ARGS (appended as-is)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROMETHEUS_URL="${PROMETHEUS_URL:-http://127.0.0.1:59090}"
POSTGRES_SINK_URL="${POSTGRES_SINK_URL:-postgresql://pgwatch@127.0.0.1:55433/measurements}"
OUTPUT_DIR="${OUTPUT_DIR:-${REPO_ROOT}/dev_reports/dev_report_$(date -u +%Y%m%d_%H%M%S)}"
EXTRA_ARGS="${EXTRA_ARGS:-}"

if [[ -z "${VIRTUAL_ENV:-}" ]] && [[ -f "${REPO_ROOT}/.venv/bin/activate" ]]; then
  # Convenience: auto-activate local venv if present.
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.venv/bin/activate"
fi

cd "${REPO_ROOT}"

mkdir -p "${OUTPUT_DIR}"

# Reporter always writes per-check files to the current working directory.
# If we pass --output <file>, it ALSO writes a combined JSON.
# For local dev, we want only per-check files in a timestamped directory.
cd "${OUTPUT_DIR}"

# Run as a module so imports like "from reporter.logger import logger" work
# regardless of the current working directory.
PYTHONPATH="${REPO_ROOT}${PYTHONPATH:+:${PYTHONPATH}}" \
python -m reporter.postgres_reports \
  --prometheus-url "${PROMETHEUS_URL}" \
  --postgres-sink-url "${POSTGRES_SINK_URL}" \
  --no-upload \
  --output "-" \
  ${EXTRA_ARGS}

echo "Wrote reports to: ${OUTPUT_DIR}"


