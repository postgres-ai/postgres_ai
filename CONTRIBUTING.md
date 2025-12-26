# Contributing (Local Development)

This document describes how to run Postgres AI Monitoring locally for development.

## Prerequisites

- Docker + Docker Compose v2
- Git

## Repo setup

If you cloned the repo with submodules, make sure the `.cursor` submodule is initialized:

```bash
git submodule update --init --recursive
```

## Local development (always rebuild images)

The default `docker-compose.yml` uses published images. For local development you can opt-in to building services from source via `docker-compose.local.yml`.

### Make targets (optional)

```bash
make up
make up-local
```

### Option A: Run via the `postgres_ai` script (recommended)

`postgres_ai` uses a single compose file path stored in `COMPOSE_FILE`. You can override it to include the local compose override:

```bash
COMPOSE_FILE="docker-compose.yml:docker-compose.local.yml" ./postgres_ai quickstart --demo -y
```

To rebuild on every run:

```bash
COMPOSE_FILE="docker-compose.yml:docker-compose.local.yml" \
  docker compose -f docker-compose.yml -f docker-compose.local.yml build --no-cache

COMPOSE_FILE="docker-compose.yml:docker-compose.local.yml" ./postgres_ai restart
```

### Option B: Run Docker Compose directly

Bring the stack up and **force rebuild**:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build --force-recreate
```

If you want to rebuild everything without cache (slow, but deterministic):

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml build --no-cache --pull
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --force-recreate
```

## Common workflows

### Reset everything

```bash
./postgres_ai reset
```

### View logs

```bash
./postgres_ai logs
./postgres_ai logs grafana
./postgres_ai logs monitoring_flask_backend
```

### Stop / start

```bash
./postgres_ai stop
./postgres_ai start
```


