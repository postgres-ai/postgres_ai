FROM python:3.11-slim

ARG VERSION
RUN test -n "${VERSION}" || (echo "VERSION build arg is required" && exit 1)

LABEL org.opencontainers.image.title="PostgresAI Reporter"
LABEL org.opencontainers.image.description="Automated Postgres health check and monitoring reports"
LABEL org.opencontainers.image.vendor="PostgresAI"
LABEL org.opencontainers.image.source="https://github.com/PostgresAI/postgres-ai-monitoring"
LABEL org.opencontainers.image.version="${VERSION}"

# Set working directory
WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy reporter script
COPY postgres_reports.py .

# Make script executable
RUN chmod +x postgres_reports.py

# Create reports directory
RUN mkdir -p /app/reports

# Default command
CMD ["python", "postgres_reports.py"]

