#!/bin/bash
set -e

# Logging
exec > >(tee /var/log/startup-script.log)
exec 2>&1

echo "Starting postgres_ai monitoring setup..."

# Update system
apt-get update
apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release

# Install Docker
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Install Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Create postgres_ai user
useradd -r -s /bin/bash -d /home/postgres_ai -m postgres_ai
usermod -aG docker postgres_ai

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

# Clone repository
cd /home/postgres_ai
if [ ! -d "postgres_ai" ]; then
  git clone https://github.com/postgres-ai/postgres_ai.git
fi
cd postgres_ai
chown -R postgres_ai:postgres_ai /home/postgres_ai

# Create .env file for docker-compose
cat > .env <<ENV_EOF
GRAFANA_PASSWORD=${grafana_password}
ENV_EOF

# Configure monitoring instances
%{ if length(monitoring_instances) > 0 }
cat > instances.yml <<'INSTANCES_EOF'
%{ for instance in monitoring_instances ~}
- name: ${instance.name}
  conn_str: ${instance.conn_str}
  preset_metrics: full
  custom_metrics:
  is_enabled: true
  group: default
  custom_tags:
    env: ${instance.environment}
    cluster: ${instance.cluster}
    node_name: ${instance.node_name}
    sink_type: ~sink_type~
%{ endfor ~}
INSTANCES_EOF
%{ else }
cat > instances.yml <<'INSTANCES_EOF'
# PostgreSQL instances to monitor
# Add your instances using: ./postgres_ai add-instance

INSTANCES_EOF
%{ endif }

# Configure .pgwatch-config
cat > .pgwatch-config <<'PGWATCH_EOF'
prometheus:
  sink_db_conn_str: "host=sink-postgres port=5432 user=postgres dbname=postgres password=postgres sslmode=disable"
  instance_conn_str: "host=pgwatch-prometheus port=5432 user=postgres dbname=postgres password=postgres sslmode=disable"

postgres:
  sink_db_conn_str: "host=sink-postgres port=5432 user=postgres dbname=postgres password=postgres sslmode=disable"
  instance_conn_str: "host=pgwatch-postgres port=5432 user=postgres dbname=postgres password=postgres sslmode=disable"
PGWATCH_EOF

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

# Reset Grafana admin password to match terraform config
echo "Setting Grafana admin password..."
cd /home/postgres_ai/postgres_ai
docker exec grafana-with-datasources grafana-cli admin reset-admin-password "${grafana_password}" 2>/dev/null || true

echo "Installation complete!"
echo "Access Grafana at: http://$(curl -s http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip -H "Metadata-Flavor: Google"):3000"
echo "Username: monitor"
echo "Password: ${grafana_password}"

