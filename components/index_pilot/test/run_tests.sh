#!/bin/bash
# Test runner for pg_index_pilot
# Can be used locally or in CI/CD pipelines

# Don't use set -e as we need to handle test failures gracefully
set -u
set -o pipefail # Still fail on pipe errors

# Default values
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-test_index_pilot}"
DB_USER="${DB_USER:-postgres}"
DB_PASS="${DB_PASS:-}"
INSTALL_ONLY="${INSTALL_ONLY:-false}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"

# Control database architecture
CONTROL_DB="${DB_NAME}_control"
TARGET_DB="${DB_NAME}"

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m' # No Color

# Usage
usage() {
  {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "pg_index_pilot Test Suite - Control Database Architecture"
    echo ""
    echo "This test suite requires control database architecture:"
    echo "  - Control DB: \\${DB_NAME}_control (contains pg_index_pilot schema)"
    echo "  - Target DB:  \\${DB_NAME} (contains test data)"
    echo ""
    echo "Options:"
    echo "  -h HOST       Database host (default: localhost)"
    echo "  -p PORT       Database port (default: 5432)"
    echo "  -d DATABASE   Database name (default: test_index_pilot)"
    echo "  -u USER       Database user (default: postgres)"
    echo "  -w PASSWORD   Database password"
    echo "  -i            Install only, don't run tests"
    echo "  -s            Skip installation, run tests only (requires existing setup)"
    echo "  -?            Show this help"
    echo ""
    echo "Environment variables:"
    echo "  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, SKIP_CLEANUP"
    echo ""
    echo "Examples:"
    echo "  $0 -h localhost -u postgres -w password    # Full test with setup"
    echo "  SKIP_CLEANUP=true $0 -u postgres           # Keep databases after tests"
    echo "  $0 -s -u index_pilot                       # Non-superuser tests only"
  } >&2
  exit 1
}

# Parse arguments
while getopts "h:p:d:u:w:is?" opt; do
  case $opt in
    h) DB_HOST="$OPTARG" ;;
    p) DB_PORT="$OPTARG" ;;
    d) DB_NAME="$OPTARG" ;;
    u) DB_USER="$OPTARG" ;;
    w) DB_PASS="$OPTARG" ;;
    i) INSTALL_ONLY="true" ;;
    s) SKIP_INSTALL="true" ;;
    ?) usage ;;
    *) usage ;;
  esac
done

# Set PGPASSWORD if provided
if [[ -n "${DB_PASS}" ]]; then
  export PGPASSWORD="${DB_PASS}"
fi

# Connection parameters are used directly in commands

echo "========================================"
echo "pg_index_pilot Test Suite"
echo "========================================"
echo "Host: ${DB_HOST}:${DB_PORT}"
echo "Control Database: ${CONTROL_DB}"
echo "Target Database: ${TARGET_DB}"
echo "User: ${DB_USER}"
echo ""

# Description: Run a SQL file against a target database and report status.
# Globals: DB_HOST, DB_PORT, DB_USER, CONTROL_DB, YELLOW, GREEN, RED, NC
# Args: $1 path to SQL file; $2 description; $3 optional target DB
# Outputs: Colored status lines; writes psql output to /tmp/test_output.log on failure
# Returns: 0 on success, 1 on failure
run_sql() {
  local file=$1
  local description=$2
  local target_db=${3:-${CONTROL_DB}} # Default to control database
  echo -e "${YELLOW}Running: ${description}${NC}"
  if psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${target_db}" -f "${file}" > /tmp/test_output.log 2>&1; then
    echo -e "${GREEN}✓ ${description} passed${NC}"
    return 0
  else
    echo -e "${RED}✗ ${description} failed${NC}" >&2
    echo "Error output:" >&2
    cat /tmp/test_output.log >&2
    return 1
  fi
}

# Check PostgreSQL version
echo "Checking PostgreSQL version..."
PG_VERSION=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d postgres -tAc "SELECT current_setting('server_version_num')::int" || echo "0")
if [[ "${PG_VERSION}" -lt 130000 ]]; then
  echo -e "${RED}Error: PostgreSQL 13 or higher required (found: ${PG_VERSION})${NC}" >&2
  exit 1
fi
echo -e "${GREEN}✓ PostgreSQL version OK${NC}"
echo ""

# Create test databases (control + target)
if [[ "${SKIP_INSTALL}" != "true" ]]; then
  echo "Setting up test databases for control database architecture..."

  psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d postgres -c "DROP DATABASE IF EXISTS ${CONTROL_DB}" 2> /dev/null || true
  psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d postgres -c "DROP DATABASE IF EXISTS ${TARGET_DB}" 2> /dev/null || true

  if ! psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d postgres -c "CREATE DATABASE ${CONTROL_DB}"; then
    echo -e "${RED}Error: Failed to create control database ${CONTROL_DB}${NC}" >&2
    exit 1
  fi
  echo -e "${GREEN}✓ Control database created: $CONTROL_DB${NC}"

  if ! psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d postgres -c "CREATE DATABASE ${TARGET_DB}"; then
    echo -e "${RED}Error: Failed to create target database ${TARGET_DB}${NC}" >&2
    exit 1
  fi
  echo -e "${GREEN}✓ Target database created: $TARGET_DB${NC}"
  echo ""

  # Install pg_index_pilot in control database
  echo "Installing pg_index_pilot in control database..."

  # Create extensions in control database
  psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "CREATE EXTENSION IF NOT EXISTS dblink"
  psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "CREATE EXTENSION IF NOT EXISTS postgres_fdw"

  # Install schema and functions in control database
  if [[ -f "index_pilot_tables.sql" ]]; then
    if ! run_sql "index_pilot_tables.sql" "Schema installation" "${CONTROL_DB}"; then
      echo -e "${RED}Error: Schema installation failed${NC}" >&2
      exit 1
    fi
    if ! run_sql "index_pilot_functions.sql" "Functions installation" "${CONTROL_DB}"; then
      exit 1
    fi
    if ! run_sql "index_pilot_fdw.sql" "FDW functions installation" "${CONTROL_DB}"; then
      echo -e "${RED}Error: Functions installation failed${NC}" >&2
      exit 1
    fi
  elif [[ -f "../index_pilot_tables.sql" ]]; then
    if ! run_sql "../index_pilot_tables.sql" "Schema installation" "${CONTROL_DB}"; then
      echo -e "${RED}Error: Schema installation failed${NC}" >&2
      exit 1
    fi
    if ! run_sql "../index_pilot_functions.sql" "Functions installation" "${CONTROL_DB}"; then
      exit 1
    fi
    if ! run_sql "../index_pilot_fdw.sql" "FDW functions installation" "${CONTROL_DB}"; then
      echo -e "${RED}Error: Functions installation failed${NC}" >&2
      exit 1
    fi
  else
    echo -e "${RED}Error: Cannot find installation files${NC}" >&2
    exit 1
  fi

  echo -e "${GREEN}✓ Installation complete${NC}"

  # Setup control database architecture - register target database
  echo "Setting up control database architecture with target database registration..."

  # Try different hostnames for FDW connection
  # In CI/Docker, we need to find the right hostname for FDW to connect
  FDW_SETUP_SUCCESS=false

  # In GitLab CI, the postgres service is accessible via 'postgres' hostname
  # But FDW needs to connect from within the database, so we need the right internal hostname
  if [[ "${DB_HOST}" == "postgres" ]]; then
    # In CI, try postgres first (service name), then localhost for loopback
    FDW_HOSTS="postgres localhost 127.0.0.1"
  else
    # For external hosts (like RDS), use the actual hostname
    FDW_HOSTS="${DB_HOST}"
  fi

  for FDW_HOST in $FDW_HOSTS; do
    echo "Trying FDW setup with host: $FDW_HOST"

    # Drop existing server if any
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
            DROP SERVER IF EXISTS index_pilot_target CASCADE;
            DELETE FROM index_pilot.target_databases WHERE fdw_server_name = 'index_pilot_target';
        " 2> /dev/null || true

    # Create FDW server
    if psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
            CREATE SERVER index_pilot_target
            FOREIGN DATA WRAPPER postgres_fdw
            OPTIONS (host '${FDW_HOST}', port '${DB_PORT}', dbname '${TARGET_DB}');
        " 2> /dev/null; then
      echo "FDW server created with host: $FDW_HOST"

      # Register target database
      psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
                INSERT INTO index_pilot.target_databases (database_name, host, port, fdw_server_name, enabled)
                VALUES ('${TARGET_DB}', '${FDW_HOST}', ${DB_PORT}, 'index_pilot_target', true);
            " 2> /dev/null || true

      FDW_SETUP_SUCCESS=true
      break
    fi
  done

  if [[ "${FDW_SETUP_SUCCESS}" = "false" ]]; then
    echo -e "${RED}ERROR: Failed to setup FDW server with any hostname${NC}" >&2
    echo "Tried: ${DB_HOST}, localhost, 127.0.0.1"
    exit 1
  fi

  # Setup user mapping with password if provided
  if [[ -n "${DB_PASS}" ]]; then
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
            CREATE USER MAPPING FOR ${DB_USER} SERVER index_pilot_target OPTIONS (user '${DB_USER}', password '${DB_PASS}');
        " || echo "Warning: Could not setup user mapping"
  else
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
            CREATE USER MAPPING FOR ${DB_USER} SERVER index_pilot_target;
        " || echo "Warning: Could not setup user mapping"
  fi

  # Test FDW connection actually works - REQUIRED
  echo "Testing FDW connection..."
  FDW_TEST_SUCCESS=false

  # Try to test the connection from control to target database
  if psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
        SELECT index_pilot._connect_securely('${TARGET_DB}'::name);
    " 2> /dev/null; then
    FDW_TEST_SUCCESS=true
    echo -e "${GREEN}✓ FDW connection test successful${NC}"
  else
    # If initial test fails and we're in CI, try recreating with different approach
    if [[ "${DB_HOST}" == "postgres" ]]; then
      echo "FDW connection failed with 'postgres', trying Docker network IP..."

      # Get the actual IP of the postgres container in Docker network
      # In GitLab CI, containers can reach each other via Docker network IPs
      # Remove CIDR notation if present (e.g., 172.17.0.3/32 -> 172.17.0.3)
      POSTGRES_IP=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -tAc "SELECT host(inet_server_addr())" 2> /dev/null || echo "")

      if [[ -n "${POSTGRES_IP}" ]] && [[ "${POSTGRES_IP}" != "" ]]; then
        echo "Found PostgreSQL server IP: ${POSTGRES_IP}"

        # Recreate FDW with actual IP
        psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
                    DROP SERVER IF EXISTS index_pilot_target CASCADE;
                    DELETE FROM index_pilot.target_databases WHERE fdw_server_name = 'index_pilot_target';
                    CREATE SERVER index_pilot_target
                    FOREIGN DATA WRAPPER postgres_fdw
                    OPTIONS (host '${POSTGRES_IP}', port '${DB_PORT}', dbname '${TARGET_DB}');
                    INSERT INTO index_pilot.target_databases (database_name, host, port, fdw_server_name, enabled)
                    VALUES ('${TARGET_DB}', '${POSTGRES_IP}', ${DB_PORT}, 'index_pilot_target', true);
                    CREATE USER MAPPING FOR ${DB_USER} SERVER index_pilot_target OPTIONS (user '${DB_USER}', password '${DB_PASS}');
                " 2> /dev/null

        # Note: For RDS, ensure current_user has proper user mapping

        # Test again with IP
        if psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
                    SELECT index_pilot._connect_securely('${TARGET_DB}'::name);
                " 2> /dev/null; then
          FDW_TEST_SUCCESS=true
          echo -e "${GREEN}✓ FDW connection test successful with IP: ${POSTGRES_IP}${NC}"
        fi
      fi
    fi
  fi

  if [[ "${FDW_TEST_SUCCESS}" = "false" ]]; then
    echo -e "${RED}ERROR: FDW connection test failed${NC}" >&2
    echo "The tool requires FDW to function. Debugging info:"

    # Show current FDW configuration for debugging
    echo "Current FDW configuration:"
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
            SELECT srvname, srvoptions FROM pg_foreign_server WHERE srvname = 'index_pilot_target';
        " 2>&1 || true

    echo "Attempting direct connection test:"
    psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
            SELECT index_pilot._connect_securely('${TARGET_DB}'::name);
        " 2>&1 || true

    exit 1
  fi

  echo -e "${GREEN}✓ FDW setup complete${NC}"
  echo ""
fi

if [[ "${INSTALL_ONLY}" == "true" ]]; then
  echo "Installation complete (install-only mode)"
  exit 0
fi

# Check if we're in skip install mode and databases don't exist
if [[ "${SKIP_INSTALL}" = "true" ]]; then
  echo "Checking if control database exists for non-superuser tests..."
  if ! psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "${YELLOW}WARNING: Control database ${CONTROL_DB} does not exist${NC}" >&2
    echo "Non-superuser tests require the control database to be set up by superuser tests first."
    echo "Skipping tests gracefully."
    echo ""
    echo "========================================"
    echo "Test Summary"
    echo "========================================"
    echo -e "${YELLOW}Skipped: Control database not available for non-superuser tests${NC}"
    exit 0
  fi
  echo -e "${GREEN}✓ Control database exists${NC}"

  # Also verify target database is registered and accessible
  echo "Verifying target database configuration..."
  if ! psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d "${CONTROL_DB}" -c "
        SELECT database_name FROM index_pilot.target_databases WHERE enabled = true LIMIT 1;
    " > /dev/null 2>&1; then
    echo -e "${YELLOW}WARNING: No target databases configured in control database${NC}" >&2
    echo "Non-superuser tests require target database to be registered."
    echo "Skipping tests gracefully."
    exit 0
  fi
  echo -e "${GREEN}✓ Target database configuration verified${NC}"
fi

# Run tests
echo "Running test suite..."
echo ""

TESTS_PASSED=0
TESTS_FAILED=0

# Find test directory
if [[ -d "test" ]]; then
  TEST_DIR="test"
elif [[ -d "." ]] && [[ -f "01_basic_installation.sql" ]]; then
  TEST_DIR="."
else
  echo -e "${RED}Error: Cannot find test files${NC}"
  echo "Current directory: $(pwd)"
  echo "Files in current directory:"
  ls -la
  if [[ -d "test" ]]; then
    echo "Files in test directory:"
    ls -la test/
  fi
  exit 1
fi

echo "Using test directory: ${TEST_DIR}"
echo "Test files found:"
ls -la "${TEST_DIR}"/*.sql 2> /dev/null || echo "No .sql files found in ${TEST_DIR}"

# Initialize JUnit XML output
# Always create in test/ directory for CI artifact collection
if [[ -d "test" ]] && [[ "${TEST_DIR}" == "test" ]]; then
  JUNIT_FILE="test/test-results.xml"
else
  JUNIT_FILE="test-results.xml"
fi
echo '<?xml version="1.0" encoding="UTF-8"?>' > "${JUNIT_FILE}"
echo '<testsuites name="pg_index_pilot" tests="0" failures="0" time="0">' >> "${JUNIT_FILE}"
echo '  <testsuite name="index_pilot_tests">' >> "${JUNIT_FILE}"

# Run each test
START_TIME=$(date +%s)
# Use find to get test files to avoid glob issues
TEST_FILES=$(find "${TEST_DIR}" -name "[0-9]*.sql" -type f | sort)

if [[ -z "${TEST_FILES}" ]]; then
  echo -e "${RED}Error: No test files found in ${TEST_DIR}${NC}" >&2
  exit 1
fi

echo "Running $(echo "${TEST_FILES}" | wc -l) test files..."

IFS=$'\n' # Set Internal Field Separator to newline for the loop
for test_file in ${TEST_FILES}; do
  echo "Processing: ${test_file}"
  if [[ -f "${test_file}" ]]; then
    test_name=$(basename "${test_file}" .sql)
    TEST_START=$(date +%s)

    if run_sql "${test_file}" "${test_name}"; then
      ((TESTS_PASSED++))
      TEST_END=$(date +%s)
      TEST_TIME=$((TEST_END - TEST_START))
      echo "    <testcase name=\"${test_name}\" classname=\"index_pilot\" time=\"${TEST_TIME}\"/>" >> "${JUNIT_FILE}"
    else
      ((TESTS_FAILED++))
      TEST_END=$(date +%s)
      TEST_TIME=$((TEST_END - TEST_START))
      ERROR_MSG=$(head -50 /tmp/test_output.log | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g')
      {
        echo "    <testcase name=\"${test_name}\" classname=\"index_pilot\" time=\"${TEST_TIME}\">"
        echo "      <failure message=\"Test failed\">$ERROR_MSG</failure>"
        echo "    </testcase>"
      } >> "${JUNIT_FILE}"
    fi
  else
    echo "Warning: File not found: ${test_file}" >&2
  fi
done
unset IFS # Reset IFS

END_TIME=$(date +%s)
TOTAL_TIME=$((END_TIME - START_TIME))

# Close JUnit XML
echo '  </testsuite>' >> "${JUNIT_FILE}"
echo '</testsuites>' >> "${JUNIT_FILE}"

# Update test counts in XML
sed -i.bak "s/tests=\"0\"/tests=\"$((TESTS_PASSED + TESTS_FAILED))\"/" "${JUNIT_FILE}"
sed -i.bak "s/failures=\"0\"/failures=\"${TESTS_FAILED}\"/" "${JUNIT_FILE}"
sed -i.bak "s/time=\"0\"/time=\"${TOTAL_TIME}\"/" "${JUNIT_FILE}"
rm -f "${JUNIT_FILE}.bak"

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed: ${TESTS_PASSED}${NC}"
if [[ ${TESTS_FAILED} -gt 0 ]]; then
  echo -e "${RED}Failed: ${TESTS_FAILED}${NC}"
else
  echo -e "${GREEN}Failed: 0${NC}"
fi
echo ""

# Cleanup
if [[ "${SKIP_INSTALL}" != "true" ]] && [[ "${SKIP_CLEANUP:-false}" != "true" ]]; then
  echo "Cleaning up..."
  psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d postgres -c "DROP DATABASE IF EXISTS ${CONTROL_DB}" 2> /dev/null || true
  psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -X -d postgres -c "DROP DATABASE IF EXISTS ${TARGET_DB}" 2> /dev/null || true
  echo -e "${GREEN}✓ Cleanup complete${NC}"
elif [[ "${SKIP_INSTALL}" != "true" ]]; then
  echo "Skipping cleanup (SKIP_CLEANUP=true)"
fi

# Exit with appropriate code
if [[ $TESTS_FAILED -gt 0 ]]; then
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
