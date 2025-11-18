FROM python:3.11-slim

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

