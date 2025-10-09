# AWS deployment

Single EC2 instance deployment with Docker Compose.

## Architecture

Single EC2 instance with Docker Compose.

Terraform creates:
- VPC with public subnet
- EC2 instance (t3.medium, Ubuntu 22.04 LTS)
- EBS volume (50 GiB gp3, encrypted)
- Security Group (SSH + Grafana ports)
- Elastic IP (optional)

On first boot, EC2 instance clones this repository and runs `docker-compose up` to start all monitoring services.

## Quick start

See [QUICKSTART.md](QUICKSTART.md) for step-by-step guide.

## Configuration

### Minimal setup

```hcl
# terraform.tfvars
ssh_key_name = "postgres-ai-key"

# Optional: Set custom Grafana password (defaults to 'demo')
# grafana_password = "YourSecurePassword123!"
```

### Minimal production setup

```hcl
# terraform.tfvars

# REQUIRED PARAMETERS
ssh_key_name = "your-key-name"

# AWS SETTINGS
aws_region = "us-east-1"
environment = "production"
instance_type = "t3.medium"

# STORAGE
data_volume_size = 50 # GiB

# SECURITY (restrict access!)
allowed_ssh_cidr = ["0.0.0.0/0"] # WARNING: Allows access from anywhere
allowed_cidr_blocks = ["0.0.0.0/0"] # WARNING: Allows access from anywhere

# OPTIONAL PARAMETERS
# grafana_password = "YourSecurePassword123!" # Defaults to 'demo'
# postgres_ai_api_key = "your-api-key" # For uploading reports
# enable_demo_db = false # true for testing
# use_elastic_ip = true # Stable IP address

monitoring_instances = [
  {
    name = "main-db"
    conn_str = "postgresql://monitor:pass@db.example.com:5432/postgres"
    environment = "production"
    cluster = "main"
    node_name = "primary"
  }
]
```

### Full configuration

```hcl
# AWS
aws_region = "us-east-1"
environment = "production"
instance_type = "t3.medium"

# Storage
data_volume_size = 50

# Security (restrict access in production)
allowed_ssh_cidr = ["203.0.113.0/24"]
allowed_cidr_blocks = ["203.0.113.0/24"]

# Required
ssh_key_name = "ssh-key"

# Optional
grafana_password = "SecurePassword123!" # Defaults to 'demo'
postgres_ai_api_key = "your-api-key"
enable_demo_db = false
use_elastic_ip = true

# Monitoring instances
monitoring_instances = [
  {
    name = "prod-db"
    conn_str = "postgresql://monitor:pass@db.example.com:5432/postgres"
    environment = "production"
    cluster = "main"
    node_name = "primary"
  }
]
```

## Management

### SSH access

```bash
terraform output ssh_command
# Or directly:
ssh -i ~/.ssh/postgres-ai-key.pem ubuntu@$(terraform output -raw public_ip)
```

### Service management

```bash
# On EC2 instance
cd /home/postgres_ai/postgres_ai

# Status
sudo docker-compose ps

# Logs
sudo docker-compose logs -f

# Restart
sudo systemctl restart postgres-ai
```

### Add monitoring instance

Method 1: Update terraform.tfvars and run `terraform apply`

Method 2: Manual configuration on server:
```bash
ssh ubuntu@your-ip
cd /home/postgres_ai/postgres_ai
sudo -u postgres_ai vim instances.yml
sudo docker-compose restart
```

### Backup

```bash
# Create snapshot
aws ec2 create-snapshot \
  --volume-id $(terraform output -raw data_volume_id) \
  --description "postgres-ai backup $(date +%Y-%m-%d)"
```

### System updates

```bash
ssh ubuntu@your-ip

# Update OS
sudo apt-get update && sudo apt-get upgrade -y

# Update Docker images
cd /home/postgres_ai/postgres_ai
sudo docker-compose pull
sudo docker-compose up -d
```

## Security

### Recommendations

1. Restrict SSH access:
```hcl
allowed_ssh_cidr = ["your.ip.address/32"]
```

2. Restrict Grafana access:
```hcl
allowed_cidr_blocks = ["your.office.ip/24"]
```

3. Use AWS Systems Manager instead of SSH:
```bash
aws ssm start-session --target $(terraform output -raw instance_id)
```

4. Automate backups with AWS Backup or cron.

## Monitoring

### CloudWatch metrics

```bash
# CPU utilization
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=$(terraform output -raw instance_id) \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Average
```

### Disk space

```bash
ssh ubuntu@your-ip "df -h /data"
```

## Troubleshooting

### Services not starting

```bash
# Check user-data log
ssh ubuntu@your-ip "sudo cat /var/log/user-data.log"

# Check Docker
ssh ubuntu@your-ip "sudo systemctl status docker"
ssh ubuntu@your-ip "sudo docker ps -a"
```

### No access to Grafana

```bash
# Check Security Group
aws ec2 describe-security-groups \
  --group-ids $(terraform output -raw security_group_id)

# Check services
ssh ubuntu@your-ip "sudo docker-compose ps"
```

### Disk full

```bash
# Increase EBS volume size
aws ec2 modify-volume --volume-id VOLUME_ID --size 200

# Expand filesystem
ssh ubuntu@your-ip "sudo resize2fs /dev/nvme1n1"
```

## Instance sizing

Choose instance type based on monitoring workload:

```hcl
instance_type = "t3.medium"  # 2 vCPU, 4 GiB RAM
```

Suitable for:
- Monitoring 1-3 small databases
- Dev/test environments
- Proof of concept

```hcl
instance_type = "t3.medium"  # 2 vCPU, 8 GiB RAM (default)
```

Suitable for:
- Monitoring 3-10 databases
- Production environments

```hcl
instance_type = "t3.xlarge"  # 4 vCPU, 16 GiB RAM
```

Suitable for:
- Monitoring 10+ databases
- High-frequency metric collection

## Custom domain

```bash
# Create A record in Route53
aws route53 change-resource-record-sets \
  --hosted-zone-id YOUR_ZONE_ID \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "monitoring.example.com",
        "Type": "A",
        "TTL": 300,
        "ResourceRecords": [{"Value": "'"$(terraform output -raw public_ip)"'"}]
      }
    }]
  }'

# Configure HTTPS with Let's Encrypt
ssh ubuntu@your-ip
sudo snap install certbot
sudo certbot certonly --standalone -d monitoring.example.com
```

## Limitations

Single AZ deployment:
- No automatic failover
- Manual backups required
- Vertical scaling only
- Suitable for 1-10 databases

Recovery time: 15-30 minutes (restore from snapshot)

## Use cases

This deployment is appropriate for:
- Development and testing environments
- Small to medium workloads (1-10 databases)
- Non-critical monitoring systems
- Budget-constrained projects
- Teams with Linux administration skills

For production-critical systems requiring high availability, consider managed services (RDS, ECS Fargate) instead.
