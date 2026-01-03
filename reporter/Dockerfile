FROM python:3.11-slim

ARG VERSION
RUN test -n "${VERSION}" || (echo "VERSION build arg is required" && exit 1)
ARG BUILD_TS
RUN test -n "${BUILD_TS}" || (echo "BUILD_TS build arg is required" && exit 1)

LABEL org.opencontainers.image.title="PostgresAI Reporter"
LABEL org.opencontainers.image.description="Automated Postgres health check and monitoring reports"
LABEL org.opencontainers.image.vendor="PostgresAI"
LABEL org.opencontainers.image.source="https://github.com/PostgresAI/postgres-ai-monitoring"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_TS}"

# Set working directory
WORKDIR /app

# Install dependencies
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy the full reporter package (postgres_reports.py imports reporter.*)
RUN mkdir -p /app/reporter
COPY . /app/reporter

# Make script executable
RUN chmod +x /app/reporter/postgres_reports.py

# Embed build metadata into the image filesystem
RUN printf '%s' "${VERSION}" > /VERSION \
  && printf '%s' "${BUILD_TS}" > /BUILD_TS

# Create reports directory
RUN mkdir -p /app/reports

# Default command
CMD ["python", "-m", "reporter.postgres_reports"]

