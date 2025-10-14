#!/bin/bash
set -e

# Logging
exec > >(tee /var/log/startup-script.log)
exec 2>&1

echo "Starting postgres_ai monitoring setup..."

# Note: Docker, docker-compose, and postgres_ai user are pre-installed in Packer image
# Ensure postgres_ai user is in docker group (idempotent)
usermod -aG docker postgres_ai || true

# Format and mount data disk
DATA_DISK="/dev/disk/by-id/google-data-disk"
if [ -b "$DATA_DISK" ]; then
  # Check if disk has filesystem
  if ! blkid "$DATA_DISK"; then
    echo "Formatting data disk..."
    mkfs.ext4 -F "$DATA_DISK"
  fi
  
  # Mount data disk
  mkdir -p /mnt/data
  mount "$DATA_DISK" /mnt/data
  
  # Add to fstab for persistence
  if ! grep -q "$DATA_DISK" /etc/fstab; then
    echo "$DATA_DISK /mnt/data ext4 defaults,nofail 0 2" >> /etc/fstab
  fi
  
  # Set ownership
  chown postgres_ai:postgres_ai /mnt/data
fi

# Update repository to desired version (repository is pre-cloned in Packer image)
cd /home/postgres_ai/postgres_ai
sudo -u postgres_ai git fetch --all
sudo -u postgres_ai git checkout ${postgres_ai_version}
sudo -u postgres_ai git pull origin ${postgres_ai_version} || true

# Create .env file for docker-compose with secure permissions
umask 077
cat > .env <<ENV_EOF
GF_SECURITY_ADMIN_USER=monitor
GF_SECURITY_ADMIN_PASSWORD=${grafana_password}
BIND_HOST=${bind_host}
GRAFANA_BIND_HOST=${grafana_bind_host}
ENV_EOF

# Configure monitoring instances
%{ if db_connection_string != "" && db_password != "" }
# Build full connection string with password
# Parse connection string and insert password after username
CONN_STR="${db_connection_string}"
# Insert password after username (postgresql://user:password@host...)
FULL_CONN_STR=$(echo "$CONN_STR" | sed "s|://\([^@]*\)@|://\1:${db_password}@|")

cat > instances.yml <<INSTANCES_EOF
- name: database-1
  conn_str: "$FULL_CONN_STR"
  preset_metrics: full
  custom_metrics:
  is_enabled: true
  group: default
  custom_tags:
    env: ${environment}
    cluster: main
    node_name: primary
    sink_type: ~sink_type~
%{ if enable_demo_db }
- name: demo-db
  conn_str: "postgresql://postgres:postgres@target-db:5432/postgres"
  preset_metrics: full
  custom_metrics:
  is_enabled: true
  group: default
  custom_tags:
    env: demo
    cluster: demo
    node_name: demo
    sink_type: ~sink_type~
%{ endif }
INSTANCES_EOF
%{ else }
# Use injected template if no DB connection provided
cat > instances.yml <<'INSTANCES_EOF'
${instances_yml}INSTANCES_EOF
%{ endif }

# Apply instances configuration: generate pgwatch sources files
chown postgres_ai:postgres_ai /home/postgres_ai/postgres_ai/instances.yml || true
sudo -u postgres_ai /home/postgres_ai/postgres_ai/postgres_ai update-config || true

# Configure .pgwatch-config with secure permissions
cat > .pgwatch-config <<'PGWATCH_EOF'
prometheus:
  sink_db_conn_str: "host=sink-postgres port=5432 user=postgres dbname=postgres password=postgres sslmode=disable"
  instance_conn_str: "host=pgwatch-prometheus port=5432 user=postgres dbname=postgres password=postgres sslmode=disable"

postgres:
  sink_db_conn_str: "host=sink-postgres port=5432 user=postgres dbname=postgres password=postgres sslmode=disable"
  instance_conn_str: "host=pgwatch-postgres port=5432 user=postgres dbname=postgres password=postgres sslmode=disable"
PGWATCH_EOF

# Ensure secure permissions on sensitive files
chmod 600 .env .pgwatch-config

# Configure demo database if enabled
%{ if enable_demo_db }
cat > config/target-db/init.sql <<'SQL_EOF'
CREATE TABLE IF NOT EXISTS demo_data (
  id SERIAL PRIMARY KEY,
  data TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO demo_data (data) 
SELECT 'Demo row ' || generate_series(1, 1000);
SQL_EOF
%{ endif }

# Configure PostgresAI API key if provided
%{ if postgres_ai_api_key != "" }
mkdir -p ~/.postgres_ai
cat > ~/.postgres_ai/config.yml <<'API_EOF'
api_key: ${postgres_ai_api_key}
API_EOF
%{ endif }

# Ensure ownership of all files
chown -R postgres_ai:postgres_ai /home/postgres_ai

# Ensure any previous stack is stopped and volumes cleaned (Grafana DB resets to provisioned state)
sudo -u postgres_ai /usr/local/bin/docker-compose down -v || true

# Create systemd service
cat > /etc/systemd/system/postgres-ai.service <<'SERVICE_EOF'
[Unit]
Description=Postgres AI Monitoring
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/postgres_ai/postgres_ai
ExecStart=/usr/local/bin/docker-compose up -d
ExecStop=/usr/local/bin/docker-compose down
User=postgres_ai
Group=postgres_ai

[Install]
WantedBy=multi-user.target
SERVICE_EOF

# Enable and start service
systemctl daemon-reload
systemctl enable postgres-ai
systemctl start postgres-ai

# Wait for services to be healthy
sleep 30

echo "Installation complete!"
echo "Access Grafana at: http://$(curl -s http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip -H "Metadata-Flavor: Google"):3000"
echo "Username: monitor"
echo "Password: ${grafana_password}"

