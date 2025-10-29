# PostgresAI CLI

Command-line interface for PostgresAI monitoring and database management.

## Installation

### From npm

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
postgres-ai quickstart --demo
```

This will:
- Generate secure Grafana password
- Start all monitoring services
- Open Grafana at http://localhost:3000

## Commands

### Monitoring services
```bash
postgres-ai start              # Start all services
postgres-ai stop               # Stop all services
postgres-ai restart            # Restart all services
postgres-ai status             # Show service status
postgres-ai logs [service]     # Show logs
```

### Instance management
```bash
postgres-ai list-instances                          # List configured instances
postgres-ai add-instance <conn-string> <name>       # Add new instance
postgres-ai remove-instance <name>                  # Remove instance
postgres-ai update-config                           # Regenerate config files
```

### Configuration
```bash
postgres-ai config             # Show current configuration
postgres-ai check              # Verify prerequisites
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

### Environment variables

- `PGAI_API_KEY` - API key for PostgresAI services
- `PGAI_BASE_URL` - API endpoint (default: `https://postgres.ai/api/general/`)

## Requirements

- Node.js 18 or higher
- Docker and Docker Compose

## Learn more

- Documentation: https://postgres.ai/docs
- Issues: https://gitlab.com/postgres-ai/postgres_ai/-/issues
