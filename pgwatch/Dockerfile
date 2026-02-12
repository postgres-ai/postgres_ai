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
# pgwatch's regex extracts only major.minor from extension versions. For
# extensions like supabase-dbdev (0.0.4), this yields "0.0" which
# VersionToInt() maps to 0 — treated as invalid, killing all metrics.
# Fix: return nil (continue to next extension) instead of a fatal error.
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
