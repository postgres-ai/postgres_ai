FROM alpine:3.22.0

ARG VERSION
RUN test -n "${VERSION}" || (echo "VERSION build arg is required" && exit 1)
ARG BUILD_TS
RUN test -n "${BUILD_TS}" || (echo "BUILD_TS build arg is required" && exit 1)

LABEL org.opencontainers.image.title="PostgresAI configs: YAML&JSON files for pgwatch, VictoriaMetrics, etc."
LABEL org.opencontainers.image.description="Configuration files for PostgresAI monitoring stack"
LABEL org.opencontainers.image.vendor="PostgresAI"
LABEL org.opencontainers.image.source="https://gitlab.com/postgres-ai/postgres_ai"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_TS}"

# Embed build metadata
RUN printf '%s' "${VERSION}" > /VERSION \
  && printf '%s' "${BUILD_TS}" > /BUILD_TS

# Create config directories
RUN mkdir -p /postgres_ai_configs

# Copy all configuration files
COPY grafana/ /postgres_ai_configs/grafana/
COPY pgwatch-postgres/metrics.yml /postgres_ai_configs/pgwatch/metrics.yml
COPY pgwatch-prometheus/metrics.yml /postgres_ai_configs/pgwatch-prometheus/metrics.yml
COPY prometheus/ /postgres_ai_configs/prometheus/
COPY sink-postgres/ /postgres_ai_configs/sink-postgres/
# Demo DB – used only for `quickstart --demo`
COPY target-db/ /postgres_ai_configs/target-db/

# Copy infrastructure scripts (entrypoints, generators, etc.)
COPY scripts/ /postgres_ai_configs/scripts/

# Copy script that initializes volumes
COPY --chmod=755 init-configs.sh /init-configs.sh

ENTRYPOINT ["/init-configs.sh"]

