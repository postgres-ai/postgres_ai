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

This will:
- Generate secure Grafana password
- Start all monitoring services
- Open Grafana at http://localhost:3000

## Commands

### Monitoring services management (`mon` group)

#### Service lifecycle
```bash
postgres-ai mon quickstart [--demo]    # Complete setup (generate config, start services)
postgres-ai mon start                  # Start monitoring services
postgres-ai mon stop                   # Stop monitoring services
postgres-ai mon restart [service]      # Restart all or specific monitoring service
postgres-ai mon status                 # Show monitoring services status
postgres-ai mon health [--wait <sec>]  # Check monitoring services health
```

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
pgai mcp start                 # Start MCP stdio server exposing list_issues tool
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
export PGAI_UI_BASE_URL=https://console.postgres.ai
pgai auth --debug
```

Windows PowerShell:

```powershell
$env:PGAI_API_BASE_URL = "https://v2.postgres.ai/api/general/"
$env:PGAI_UI_BASE_URL = "https://console.postgres.ai"
pgai auth --debug
```

Via CLI options (overrides env):

```bash
pgai auth --debug \
  --api-base-url https://v2.postgres.ai/api/general/ \
  --ui-base-url https://console.postgres.ai
```

Notes:
- If `PGAI_UI_BASE_URL` is not set, the default is `https://console.postgres.ai`.

## Requirements

- Node.js 18 or higher
- Docker and Docker Compose

## Learn more

- Documentation: https://postgres.ai/docs
- Issues: https://gitlab.com/postgres-ai/postgres_ai/-/issues
