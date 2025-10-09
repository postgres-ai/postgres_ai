#!/bin/bash
set -e

# Log everything
exec > >(tee /var/log/user-data.log)
exec 2>&1

echo "Starting postgres_ai monitoring installation..."

# Update system
apt-get update
apt-get upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
systemctl enable docker
systemctl start docker

# Install Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Create postgres_ai user
useradd -m -s /bin/bash postgres_ai
usermod -aG docker postgres_ai

# Mount and prepare data volume
if [ ! -d /data ]; then
    mkdir -p /data
    
    # Wait for volume to be attached
    sleep 10
    
    # Check if volume exists and format if needed
    if [ -e /dev/nvme1n1 ]; then
        DEVICE=/dev/nvme1n1
    elif [ -e /dev/xvdf ]; then
        DEVICE=/dev/xvdf
    else
        echo "Data volume not found, using root volume"
        DEVICE=""
    fi
    
    if [ -n "$DEVICE" ]; then
        # Check if filesystem exists
        if ! blkid $DEVICE; then
            mkfs.ext4 $DEVICE
        fi
        
        # Mount volume
        mount $DEVICE /data
        
        # Add to fstab for persistence
        UUID=$(blkid -s UUID -o value $DEVICE)
        echo "UUID=$UUID /data ext4 defaults,nofail 0 2" >> /etc/fstab
    fi
fi

# Set permissions
chown -R postgres_ai:postgres_ai /data

# Clone postgres_ai repository
cd /home/postgres_ai
sudo -u postgres_ai git clone https://gitlab.com/postgres-ai/postgres_ai.git

# Configure postgres_ai
cd postgres_ai

# Create configuration
cat > .pgwatch-config <<EOF
grafana_password=${grafana_password}
%{ if postgres_ai_api_key != "" }api_key=${postgres_ai_api_key}%{ endif }
%{ if enable_demo_db }demo_mode=true%{ else }demo_mode=false%{ endif }
EOF

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
# No monitoring instances configured - will use empty or default config
cat > instances.yml <<'INSTANCES_EOF'
# PostgreSQL instances to monitor
# Add your instances using: ./postgres_ai add-instance

INSTANCES_EOF
%{ endif }

# Set ownership
chown -R postgres_ai:postgres_ai /home/postgres_ai/postgres_ai

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
User=postgres_ai
Group=postgres_ai

# Start services
ExecStart=/usr/local/bin/docker-compose up -d

# Stop services
ExecStop=/usr/local/bin/docker-compose down

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
echo "Access Grafana at: http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):3000"
echo "Username: monitor"
echo "Password: ${grafana_password}"

