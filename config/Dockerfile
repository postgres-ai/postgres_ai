FROM alpine:3.22.0

ARG VERSION
RUN test -n "${VERSION}" || (echo "VERSION build arg is required" && exit 1)
ARG BUILD_TS
RUN test -n "${BUILD_TS}" || (echo "BUILD_TS build arg is required" && exit 1)

LABEL org.opencontainers.image.title="PostgresAI сonfigs: YAML&JSON files for pgwatch, VictoriaMetrics, etc."
LABEL org.opencontainers.image.description="Configuration files for PostgresAI monitoring stack"
LABEL org.opencontainers.image.vendor="PostgresAI"
LABEL org.opencontainers.image.source="https://gitlab.com/postgres-ai/postgres_ai"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_TS}"

# Embed build metadata
RUN printf '%s' "${VERSION}" > /VERSION \
  && printf '%s' "${BUILD_TS}" > /BUILD_TS

# Create config directories
RUN mkdir -p /configs

# Copy all configuration files
COPY grafana/ /configs/grafana/
COPY pgwatch-postgres/metrics.yml /configs/pgwatch/metrics.yml
COPY pgwatch-prometheus/metrics.yml /configs/pgwatch-prometheus/metrics.yml
COPY prometheus/ /configs/prometheus/
COPY sink-postgres/ /configs/sink-postgres/
# Demo DB – used only for `quickstart --demo`
COPY target-db/ /configs/target-db/

# Copy script that initializes volumes
COPY --chmod=755 init-configs.sh /init-configs.sh

ENTRYPOINT ["/init-configs.sh"]

