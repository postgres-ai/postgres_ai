#!/bin/bash
# Script to create GitLab issues for all identified security and code quality problems
# Run this script to create all issues at once

# Check if glab is installed
if ! command -v glab &> /dev/null; then
    echo "Error: glab CLI is not installed"
    echo "Install it from: https://gitlab.com/gitlab-org/cli"
    echo ""
    echo "On macOS: brew install glab"
    echo "On Linux: See https://gitlab.com/gitlab-org/cli#installation"
    exit 1
fi

# Array of issues to create
# Format: "label|title|description"
issues=(
    "security::critical|Remove hardcoded credentials from configuration files|**Description:**
Hardcoded credentials found in multiple configuration files pose a critical security vulnerability.

**Files affected:**
- \`docker-compose.yml\` (lines 28, 43, 102)
- \`config/grafana/provisioning/datasources/datasources.yml\` (line 12)
- \`instances.yml\` (line 2)

**Risk:**
- Credentials exposed in Git history
- Cannot be rotated without code changes
- Same credentials across all deployments
- Discoverable by anyone with repository access

**Solution:**
Replace all hardcoded credentials with environment variables and use .env file for configuration.

**Priority:** Critical
**Estimated Effort:** 1 day"

    "security::critical|Fix SQL injection vulnerability in Flask API|**Description:**
Direct string interpolation in SQL queries can lead to SQL injection attacks.

**Location:** \`flask-backend/app.py\` (line 590)

**Code:**
\`\`\`bash
sqlite3 /var/lib/grafana/grafana.db \"UPDATE user SET password = '\$password' WHERE login = 'monitor';\"
\`\`\`

**Risk:**
- SQL injection if password contains metacharacters
- Potential for database compromise

**Solution:**
Use parameterized queries or properly escape the password:
\`\`\`bash
escaped_password=\$(echo \"\$password\" | sed \"s/'/''/g\")
\`\`\`

**Priority:** Critical
**Estimated Effort:** 4 hours"

    "security::critical|Implement secure password generation|**Description:**
Current password generation uses weak PRNG with only 15-bit entropy.

**Location:** \`postgres_ai\` (lines 486-512)

**Risk:**
- Uses \$RANDOM (predictable, not cryptographically secure)
- Only 15-bit entropy
- Complex logic with potential collisions

**Solution:**
\`\`\`bash
openssl rand -base64 24 | tr -d \"=+/\" | head -c 20
\`\`\`

**Priority:** Critical
**Estimated Effort:** 2 hours"

    "security::critical|Add input validation for connection string parsing|**Description:**
No validation of extracted values from connection strings allows potential command injection.

**Location:** \`postgres_ai\` (lines 1288-1310)

**Risk:**
- Shell metacharacters leading to command injection
- Path traversal sequences
- Excessively long strings causing buffer issues

**Solution:**
Validate all extracted components (host format, port range, database name pattern).

**Priority:** Critical
**Estimated Effort:** 4 hours"

    "security::high|Fix unsafe file deletion operations|**Description:**
Unsafe use of \`rm -rf\` without validation could delete critical system files.

**Location:** \`postgres_ai\` (lines 725, 730)

**Risk:**
If \$project_dir is unset or manipulated, could delete critical files.

**Solution:**
Validate directory path before deletion:
- Check non-empty
- Check not root directory
- Verify matches expected pattern

**Priority:** High
**Estimated Effort:** 2 hours"

    "security::high|Fix race condition in config file updates|**Description:**
TOCTOU vulnerability in password file access with no atomic write operation.

**Location:** \`postgres_ai\` (lines 543-547)

**Risk:**
- Time-of-check-time-of-use vulnerability
- Concurrent reads could fail or get partial data
- File permissions not set explicitly

**Solution:**
Use mktemp with chmod 600 and atomic mv operation.

**Priority:** High
**Estimated Effort:** 2 hours"

    "security::high|Disable Flask debug mode in production|**Description:**
Flask debug mode enabled in main entry point exposes security risks.

**Location:** \`flask-backend/app.py\` (line 696)

**Risk:**
- Exposes stack traces with sensitive information
- Interactive debugger allowing code execution
- Automatic reloader accessing filesystem

**Solution:**
\`\`\`python
debug_mode = os.environ.get('FLASK_DEBUG', 'False').lower() == 'true'
app.run(host='0.0.0.0', port=5000, debug=debug_mode)
\`\`\`

**Priority:** High
**Estimated Effort:** 1 hour"

    "reliability::high|Add error handling and timeouts to API calls|**Description:**
Missing error handling and timeouts in critical network operations.

**Location:** \`reporter/postgres_reports.py\` (lines 1746-1749)

**Risk:**
- Network failures cause unhandled exceptions
- Hanging requests without timeout
- Invalid JSON responses crash application

**Solution:**
Add comprehensive try-except blocks and timeout parameters to all requests.

**Priority:** High
**Estimated Effort:** 4 hours"

    "security::high|Prevent Prometheus query injection|**Description:**
User-supplied values directly inserted into PromQL queries without sanitization.

**Location:** \`flask-backend/app.py\` (lines 90-102)

**Risk:**
- PromQL syntax injection
- ReDoS (Regular expression Denial of Service)
- Unauthorized metric access

**Solution:**
Sanitize all label values and escape regex patterns before query construction.

**Priority:** High
**Estimated Effort:** 4 hours"

    "reliability::high|Add request timeouts to all HTTP calls|**Description:**
No timeout specified on HTTP requests to Prometheus and other services.

**Location:** \`flask-backend/app.py\` (multiple locations)

**Risk:**
- Hanging requests never complete
- Resource exhaustion
- Denial of Service vulnerability

**Solution:**
Add \`timeout=30\` to all requests.get() and requests.post() calls.

**Priority:** High
**Estimated Effort:** 2 hours"

    "observability::medium|Implement structured logging|**Description:**
Limited logging in critical operations, no audit trail.

**Risk:**
- No audit trail for instance changes
- No authentication attempt logging
- Difficult to debug issues

**Solution:**
Implement structured JSON logging with timestamps and audit events.

**Priority:** Medium
**Estimated Effort:** 4 hours"

    "security::medium|Add input length validation|**Description:**
No limits on input lengths for query parameters allows potential DoS.

**Location:** \`flask-backend/app.py\`

**Risk:**
- Memory exhaustion from extremely long strings
- Performance degradation
- Buffer issues in underlying systems

**Solution:**
Enforce MAX_INPUT_LENGTH = 256 on all query parameters.

**Priority:** Medium
**Estimated Effort:** 3 hours"

    "infrastructure::medium|Pin Docker image versions|**Description:**
Mix of pinned and unpinned Docker image versions can cause inconsistency.

**Location:** \`docker-compose.yml\`

**Issue:**
- \`postgres:15\` uses major version only
- \`cybertecpostgresql/pgwatch:3\` uses major version only

**Solution:**
Pin to exact versions:
- \`postgres:15.8\`
- \`cybertecpostgresql/pgwatch:3.10.0\`

**Priority:** Medium
**Estimated Effort:** 1 hour"

    "security::medium|Add API rate limiting|**Description:**
No rate limiting on Flask API endpoints allows DoS attacks.

**Location:** \`flask-backend/app.py\`

**Risk:**
- API can be overwhelmed with requests
- Excessive load on Prometheus
- Resource exhaustion

**Solution:**
Implement flask-limiter with appropriate limits per endpoint.

**Priority:** Medium
**Estimated Effort:** 3 hours"

    "reliability::medium|Use timezone-aware datetime objects|**Description:**
Using naive datetime objects causes timezone bugs.

**Location:** \`reporter/postgres_reports.py\` (lines 1043-1044)

**Risk:**
- Comparison errors across timezones
- DST transition bugs
- Incorrect time calculations

**Solution:**
Use \`datetime.now(timezone.utc)\` everywhere.

**Priority:** Medium
**Estimated Effort:** 2 hours"

    "reliability::medium|Implement proper error handling with custom exceptions|**Description:**
Silent error handling returns empty dict, masking failures.

**Location:** \`reporter/postgres_reports.py\` (line 56)

**Risk:**
- Cannot distinguish between no results and errors
- Failures are masked
- Difficult to debug

**Solution:**
Create custom PrometheusQueryError exception and raise on failures.

**Priority:** Medium
**Estimated Effort:** 3 hours"

    "observability::medium|Add comprehensive health checks|**Description:**
Basic health check doesn't verify dependencies.

**Location:** \`flask-backend/app.py\`

**Missing checks:**
- Database connectivity
- Prometheus connectivity
- Disk space
- Memory usage

**Solution:**
Add /health/deep endpoint with comprehensive checks.

**Priority:** Medium
**Estimated Effort:** 4 hours"

    "code-quality::low|Apply consistent code formatting|**Description:**
Inconsistent code style throughout the codebase.

**Issues:**
- Mix of f-strings, .format(), and % formatting
- Inconsistent quote usage
- Variable naming inconsistency

**Solution:**
- Run black and isort on Python code
- Run shfmt on Bash scripts

**Priority:** Low
**Estimated Effort:** 2 hours"

    "code-quality::low|Add type hints to Python code|**Description:**
No type hints make code harder to maintain and understand.

**Solution:**
Add type annotations to all function signatures.

**Priority:** Low
**Estimated Effort:** 1 day"

    "code-quality::low|Replace magic numbers with named constants|**Description:**
Hardcoded magic numbers throughout code reduce readability.

**Examples:**
- \`sleep 1800\` (unclear)
- \`sleep 86400\` (unclear)

**Solution:**
Define named constants:
\`\`\`bash
THIRTY_MINUTES_SECONDS=1800
ONE_DAY_SECONDS=86400
\`\`\`

**Priority:** Low
**Estimated Effort:** 2 hours"

    "dependencies::low|Add version constraints to Python dependencies|**Description:**
Loose dependency versions allow breaking changes.

**Location:** \`reporter/requirements.txt\`

**Issue:**
\`\`\`
requests>=2.31.0  # Allows future major versions
\`\`\`

**Solution:**
\`\`\`
requests>=2.31.0,<3.0.0
\`\`\`

**Priority:** Low
**Estimated Effort:** 1 hour"

    "documentation::low|Add comprehensive docstrings|**Description:**
Many functions lack docstrings explaining purpose, parameters, and return values.

**Solution:**
Add docstrings to all Python functions with:
- Purpose
- Args
- Returns
- Raises
- Example

**Priority:** Low
**Estimated Effort:** 1 day"

    "reliability::low|Add file size validation before reading|**Description:**
Reading entire file into memory could cause issues with large files.

**Location:** \`reporter/postgres_reports.py\` (line 1729)

**Solution:**
Check file size before reading and enforce MAX_FILE_SIZE limit.

**Priority:** Low
**Estimated Effort:** 1 hour"

    "code-quality::low|Refactor complex one-liners|**Description:**
Complex one-liner code is difficult to understand and maintain.

**Location:** \`postgres_ai\` (line 455)

**Solution:**
Break into clear functions with comments and meaningful variable names.

**Priority:** Low
**Estimated Effort:** 2 hours"

    "observability::low|Add Prometheus metrics to Flask API|**Description:**
Flask API lacks observability metrics for itself.

**Missing:**
- Request counts
- Response times
- Error rates
- Cache hit rates

**Solution:**
Add prometheus-flask-exporter to expose /metrics endpoint.

**Priority:** Low
**Estimated Effort:** 2 hours"
)

echo "Creating GitLab issues..."
echo ""

issue_count=0
for issue_data in "${issues[@]}"; do
    IFS='|' read -r label title description <<< "$issue_data"

    issue_count=$((issue_count + 1))
    echo "[$issue_count/${#issues[@]}] Creating: $title"

    # Create the issue
    if glab issue create \
        --title "$title" \
        --description "$description" \
        --label "$label" \
        --assignee "@me" 2>/dev/null; then
        echo "  ✓ Created successfully"
    else
        echo "  ✗ Failed to create"
    fi

    # Small delay to avoid rate limiting
    sleep 1
done

echo ""
echo "✓ Created $issue_count issues"
echo ""
echo "View all issues: https://gitlab.com/postgres-ai/postgres_ai/-/issues"