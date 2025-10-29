# PostgresAI CLI

Command-line interface for PostgresAI monitoring and database management.

## Installation

```bash
npm install -g postgresai@alpha
```

## Usage

The CLI provides three command aliases:
```bash
postgres-ai --help
postgresai --help
pgai --help  # short alias
```

## Quick start

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

### API key management
```bash
postgres-ai add-key <key>      # Store API key
postgres-ai show-key           # Show stored key (masked)
postgres-ai remove-key         # Remove stored key
```

## Environment variables

- `PGAI_API_KEY` - API key for PostgresAI services
- `PGAI_BASE_URL` - API endpoint (default: `https://postgres.ai/api/general/`)

## Requirements

- Node.js 18 or higher
- Docker and Docker Compose

## Learn more

- Documentation: https://postgres.ai/docs
- Issues: https://gitlab.com/postgres-ai/postgres_ai/-/issues
