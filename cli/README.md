# PostgresAI CLI

Command-line interface for PostgresAI monitoring and database management.

## Installation

### From npm

```bash
npm install -g postgresai
```

Or install the latest alpha release explicitly:
```bash
npm install -g postgresai@alpha
```

### From Homebrew (macOS)

```bash
# Add the PostgresAI tap
brew tap postgres-ai/tap https://gitlab.com/postgres-ai/homebrew-tap.git

# Install postgresai
brew install postgresai
```

## Usage

The CLI provides three command aliases:
```bash
postgres-ai --help
postgresai --help
pgai --help  # short alias
```

## init (create monitoring user in Postgres)

This command creates (or updates) the `postgres_ai_mon` user and grants the permissions described in the root `README.md` (it is idempotent).

Run without installing (positional connection string):

```bash
npx postgresai init postgresql://admin@host:5432/dbname
```

It also accepts libpq “conninfo” syntax:

```bash
npx postgresai init "dbname=dbname host=host user=admin"
```

And psql-like options:

```bash
npx postgresai init -h host -p 5432 -U admin -d dbname
```

Password input options (in priority order):
- `--password <password>`
- `PGAI_MON_PASSWORD` environment variable
- interactive prompt (TTY only)

Optional permissions (RDS/self-managed extras from the root `README.md`) are enabled by default. To skip them:

```bash
npx postgresai init postgresql://admin@host:5432/dbname --skip-optional-permissions
```

## Quick start

### Authentication

Authenticate via browser to obtain API key:
```bash
pgai auth
```

This will:
- Open your browser for authentication
- Prompt you to select an organization
- Automatically save your API key to `~/.config/postgresai/config.json`

### Start monitoring

Start monitoring with demo database:
```bash
postgres-ai mon quickstart --demo
```

Start monitoring with your own database:
```bash
postgres-ai mon quickstart --db-url postgresql://user:pass@host:5432/db
```

Complete automated setup with API key and database:
```bash
postgres-ai mon quickstart --api-key your_key --db-url postgresql://user:pass@host:5432/db -y
```

This will:
- Configure API key for automated report uploads (if provided)
- Add PostgreSQL instance to monitor (if provided)
- Generate secure Grafana password
- Start all monitoring services
- Open Grafana at http://localhost:3000

## Commands

### Monitoring services management (`mon` group)

#### Service lifecycle
```bash
# Complete setup with various options
postgres-ai mon quickstart                                  # Interactive setup for production
postgres-ai mon quickstart --demo                           # Demo mode with sample database
postgres-ai mon quickstart --api-key <key>                  # Setup with API key
postgres-ai mon quickstart --db-url <url>                   # Setup with database URL
postgres-ai mon quickstart --api-key <key> --db-url <url>   # Complete automated setup
postgres-ai mon quickstart -y                               # Auto-accept all defaults

# Service management
postgres-ai mon start                  # Start monitoring services
postgres-ai mon stop                   # Stop monitoring services
postgres-ai mon restart [service]      # Restart all or specific monitoring service
postgres-ai mon status                 # Show monitoring services status
postgres-ai mon health [--wait <sec>]  # Check monitoring services health
```

##### Quickstart options
- `--demo` - Demo mode with sample database (testing only, cannot use with --api-key)
- `--api-key <key>` - Postgres AI API key for automated report uploads
- `--db-url <url>` - PostgreSQL connection URL to monitor (format: `postgresql://user:pass@host:port/db`)
- `-y, --yes` - Accept all defaults and skip interactive prompts

#### Monitoring target databases (`mon targets` subgroup)
```bash
postgres-ai mon targets list                       # List databases to monitor
postgres-ai mon targets add <conn-string> <name>   # Add database to monitor
postgres-ai mon targets remove <name>              # Remove monitoring target
postgres-ai mon targets test <name>                # Test target connectivity
```

#### Configuration and maintenance
```bash
postgres-ai mon config                         # Show monitoring configuration
postgres-ai mon update-config                  # Apply configuration changes
postgres-ai mon update                         # Update monitoring stack
postgres-ai mon reset [service]                # Reset service data
postgres-ai mon clean                          # Cleanup artifacts
postgres-ai mon check                          # System readiness check
postgres-ai mon shell <service>                # Open shell to monitoring service
```

### MCP server (`mcp` group)

```bash
pgai mcp start                 # Start MCP stdio server exposing tools
```

Cursor configuration example (Settings → MCP):

```json
{
  "mcpServers": {
    "PostgresAI": {
      "command": "pgai",
      "args": ["mcp", "start"],
      "env": {
        "PGAI_API_BASE_URL": "https://postgres.ai/api/general/"
      }
    }
  }
}
```

Tools exposed:
- list_issues: returns the same JSON as `pgai issues list`.
- view_issue: view a single issue with its comments (args: { issue_id, debug? })
- post_issue_comment: post a comment (args: { issue_id, content, parent_comment_id?, debug? })

### Issues management (`issues` group)

```bash
pgai issues list                                  # List issues (shows: id, title, status, created_at)
pgai issues view <issueId>                        # View issue details and comments
pgai issues post_comment <issueId> <content>      # Post a comment to an issue
# Options:
#   --parent <uuid>  Parent comment ID (for replies)
#   --debug          Enable debug output
#   --json           Output raw JSON (overrides default YAML)
```

#### Output format for issues commands

By default, issues commands print human-friendly YAML when writing to a terminal. For scripting, you can:

- Use `--json` to force JSON output:

```bash
pgai issues list --json | jq '.[] | {id, title}'
```

- Rely on auto-detection: when stdout is not a TTY (e.g., piped or redirected), output is JSON automatically:

```bash
pgai issues view <issueId> > issue.json
```

#### Grafana management
```bash
postgres-ai mon generate-grafana-password      # Generate new Grafana password
postgres-ai mon show-grafana-credentials       # Show Grafana credentials
```

### Authentication and API key management
```bash
postgres-ai auth               # Authenticate via browser (recommended)
postgres-ai add-key <key>      # Manually store API key
postgres-ai show-key           # Show stored key (masked)
postgres-ai remove-key         # Remove stored key
```

## Configuration

The CLI stores configuration in `~/.config/postgresai/config.json` including:
- API key
- Base URL
- Organization ID

### Configuration priority

API key resolution order:
1. Command line option (`--api-key`)
2. Environment variable (`PGAI_API_KEY`)
3. User config file (`~/.config/postgresai/config.json`)
4. Legacy project config (`.pgwatch-config`)

Base URL resolution order:
- API base URL (`apiBaseUrl`):
  1. Command line option (`--api-base-url`)
  2. Environment variable (`PGAI_API_BASE_URL`)
  3. User config file `baseUrl` (`~/.config/postgresai/config.json`)
  4. Default: `https://postgres.ai/api/general/`
- UI base URL (`uiBaseUrl`):
  1. Command line option (`--ui-base-url`)
  2. Environment variable (`PGAI_UI_BASE_URL`)
  3. Default: `https://console.postgres.ai`

Normalization:
- A single trailing `/` is removed to ensure consistent path joining.

### Environment variables

- `PGAI_API_KEY` - API key for PostgresAI services
- `PGAI_API_BASE_URL` - API endpoint for backend RPC (default: `https://postgres.ai/api/general/`)
- `PGAI_UI_BASE_URL` - UI endpoint for browser routes (default: `https://console.postgres.ai`)

### CLI options

- `--api-base-url <url>` - overrides `PGAI_API_BASE_URL`
- `--ui-base-url <url>` - overrides `PGAI_UI_BASE_URL`

### Examples

Linux/macOS (bash/zsh):

```bash
export PGAI_API_BASE_URL=https://v2.postgres.ai/api/general/
export PGAI_UI_BASE_URL=https://console-dev.postgres.ai
pgai auth --debug
```

Windows PowerShell:

```powershell
$env:PGAI_API_BASE_URL = "https://v2.postgres.ai/api/general/"
$env:PGAI_UI_BASE_URL = "https://console-dev.postgres.ai"
pgai auth --debug
```

Via CLI options (overrides env):

```bash
pgai auth --debug \
  --api-base-url https://v2.postgres.ai/api/general/ \
  --ui-base-url https://console-dev.postgres.ai
```

Notes:
- If `PGAI_UI_BASE_URL` is not set, the default is `https://console.postgres.ai`.

## Requirements

- Node.js 18 or higher
- Docker and Docker Compose

## Learn more

- Documentation: https://postgres.ai/docs
- Issues: https://gitlab.com/postgres-ai/postgres_ai/-/issues
