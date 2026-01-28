#!/bin/bash
# Provision preview VM - run as root on fresh Hetzner VM
set -euo pipefail

echo "=== PostgresAI Preview VM Provisioning ==="

# System updates
echo ">>> Updating system..."
apt-get update && apt-get upgrade -y

# Install Docker
echo ">>> Installing Docker..."
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Install dependencies
echo ">>> Installing dependencies..."
apt-get install -y jq rsync python3-flask curl ufw

# Create deploy user
echo ">>> Creating deploy user..."
id deploy &>/dev/null || useradd -m -s /bin/bash -G docker deploy
mkdir -p /home/deploy/.ssh
# Add the preview-deploy SSH key
cat >> /home/deploy/.ssh/authorized_keys << 'SSHKEY'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMoQ0HMzr026WCQhkyic7khErvQP8fomT+p74wi57U/h preview-deploy@ci
SSHKEY
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Create swap (prevents OOM kills)
echo ">>> Setting up swap..."
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Set swappiness to 1 (preferred for DB workloads)
sysctl vm.swappiness=1
grep -q 'vm.swappiness=1' /etc/sysctl.conf || echo 'vm.swappiness=1' >> /etc/sysctl.conf

# Docker logging limits (prevents disk exhaustion)
echo ">>> Configuring Docker logging limits..."
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
systemctl restart docker

# Create directory structure
echo ">>> Creating directory structure..."
mkdir -p /opt/postgres-ai-previews/{traefik,previews,shared/workload,manager,scripts,monitoring}
touch /opt/postgres-ai-previews/manager/.global.lock
chown -R deploy:deploy /opt/postgres-ai-previews

# Firewall
echo ">>> Configuring firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ""
echo "=== VM Provisioning Complete ==="
echo ""
echo "Next steps:"
echo "1. Add Cloudflare credentials to /opt/postgres-ai-previews/traefik/.env"
echo "2. Deploy Traefik stack"
echo "3. Test DNS record creation"
