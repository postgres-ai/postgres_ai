## Root Cause

pgwatch's `FetchRuntimeInfo` queries `pg_extension` and parses each extension's version using this SQL regex:

```sql
(regexp_matches(extversion, $$\d+\.?\d+?$$))[1]::text as extversion
```

This regex extracts only `major.minor` — for a version like `0.0.4`, it returns `"0.0"`.

Then in Go ([`internal/sources/conn.go`](https://github.com/cybertec-postgresql/pgwatch/blob/v3.7.0/internal/sources/conn.go)):

```go
extver := VersionToInt(ver)
if extver == 0 {
    return fmt.Errorf("unexpected extension %s version input: %s", ext, ver)
}
```

`VersionToInt("0.0")` returns `0`, which pgwatch treats as invalid and **returns a fatal error** — killing **all** metric gathering for that entire monitored database, not just for the problematic extension.

### Affected extension

On **Supabase**, the extension **`supabase-dbdev`** ([database.dev](https://database.dev) package manager) ships as version **0.0.4**, which triggers this bug. Any extension with a `0.0.x` version will trigger it.

## Fix

We build a patched pgwatch from upstream v3.7.0 source with a one-line `sed` fix in the Dockerfile.

### `pgwatch/Dockerfile`

```dockerfile
# Patched pgwatch build
#
# Fixes: "unexpected extension X version input: 0.0" error that kills all
# metric gathering when the monitored DB has extensions whose version
# parses to 0 (e.g. supabase-dbdev 0.0.4 → regex extracts "0.0"
# → VersionToInt returns 0 → pgwatch treats it as invalid and aborts).
#
# The one-line fix: skip the extension instead of returning a fatal
# error from FetchRuntimeInfo.
#
# Based on: cybertec-postgresql/pgwatch v3.7.0

# ---- Stage 1: build WebUI ----
FROM node:22 AS uibuilder

RUN git clone --depth 1 --branch v3.7.0 \
      https://github.com/cybertec-postgresql/pgwatch.git /src

RUN cd /src/internal/webui && yarn install --network-timeout 100000 && yarn build

# ---- Stage 2: patch & build Go binary ----
FROM golang:1.24 AS builder

COPY --from=uibuilder /src /pgwatch
COPY --from=uibuilder /src/internal/webui/build /pgwatch/internal/webui/build

# Apply the fix: skip extensions with unparseable versions instead of aborting.
RUN sed -i 's|return fmt.Errorf("unexpected extension %s version input: %s", ext, ver)|return nil /* skip unparseable extension version */|' \
    /pgwatch/internal/sources/conn.go

RUN cd /pgwatch && CGO_ENABLED=0 go build \
      -ldflags "-X 'main.version=3.7.0-patched'" \
      ./cmd/pgwatch

# ---- Stage 3: production image ----
FROM alpine:3.22

COPY --from=builder /pgwatch/pgwatch /pgwatch/
COPY --from=builder /pgwatch/internal/metrics/metrics.yaml /pgwatch/metrics/metrics.yaml

EXPOSE 8080

ENTRYPOINT ["/pgwatch/pgwatch"]
```

### `pgwatch/.dockerignore`

```
*
!Dockerfile
```

### `docker-compose.yml` change

Both pgwatch services switched from the pre-built upstream image to local build:

```yaml
pgwatch-postgres:
  image: ${PGAI_REGISTRY:-postgresai}/pgwatch:${PGAI_TAG:?PGAI_TAG is required}
  build:
    context: ./pgwatch
  # ...

pgwatch-prometheus:
  image: ${PGAI_REGISTRY:-postgresai}/pgwatch:${PGAI_TAG:?PGAI_TAG is required}
  build:
    context: ./pgwatch
  # ...
```

### What the fix does

- **Before:** `VersionToInt("0.0") == 0` → fatal error → all metrics for the database stop
- **After:** `VersionToInt("0.0") == 0` → `return nil` → skip this extension, continue collecting metrics

The fix is minimal and safe — it only changes the behavior for extensions whose version can't be parsed. All normally-versioned extensions continue to work exactly as before.

### Commit

[`15ccc69`](https://gitlab.com/postgres-ai/postgresai/-/commit/15ccc69) `fix: patch pgwatch to handle extensions with 0.0.x versions`
