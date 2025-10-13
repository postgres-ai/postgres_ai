# AWS deployment

Single EC2 instance deployment with Docker Compose.

## Architecture

Single EC2 instance with Docker Compose.

Terraform creates:
- VPC with public subnet
- EC2 instance (Ubuntu 22.04 LTS)
- EBS volumes (configurable types: gp3, st1, sc1, encrypted)
- Security Group (SSH + Grafana ports)
- Elastic IP (optional)

On first boot, EC2 instance clones the specified version of this repository and runs `docker-compose up` to start all monitoring services.

## Quick start

See [QUICKSTART.md](QUICKSTART.md) for step-by-step guide.

### Validation

```bash
# Check prerequisites
terraform version
aws sts get-caller-identity

# Validate configuration
terraform init
terraform validate
terraform plan
```

## Configuration

### Required parameters

All parameters in `terraform.tfvars` must be explicitly set (uncommented):

```hcl
# terraform.tfvars

# REQUIRED PARAMETERS
ssh_key_name         = "your-key-name"
aws_region           = "us-east-1"
environment          = "production"
instance_type        = "t3.medium"
data_volume_size     = 50
data_volume_type     = "gp3"  # gp3 (SSD), st1 (HDD), sc1 (HDD)
root_volume_type     = "gp3"
allowed_ssh_cidr     = ["203.0.113.0/24"]
allowed_cidr_blocks  = ["203.0.113.0/24"]
use_elastic_ip       = true
grafana_password     = "YourSecurePassword123!"
```

### Optional parameters

```hcl
# OPTIONAL (have defaults)
postgres_ai_api_key = "your-api-key"  # For uploading reports
enable_demo_db      = false           # Demo database (default: true)
postgres_ai_version = "main"          # Git branch/tag (default: "main")

monitoring_instances = [
  {
    name        = "main-db"
    conn_str    = "postgresql://monitor:pass@db.example.com:5432/postgres"
    environment = "production"
    cluster     = "main"
    node_name   = "primary"
  }
]
```

### Full example

```hcl
# REQUIRED
ssh_key_name         = "postgres-ai-key"
aws_region           = "us-east-1"
environment          = "production"
instance_type        = "t3.medium"
data_volume_size     = 100
data_volume_type     = "gp3"
root_volume_type     = "gp3"
allowed_ssh_cidr     = ["203.0.113.0/24"]
allowed_cidr_blocks  = ["203.0.113.0/24"]
use_elastic_ip       = true
grafana_password     = "SecurePassword123!"

# OPTIONAL
postgres_ai_api_key  = "your-api-key"
enable_demo_db       = false
postgres_ai_version  = "v0.9"

monitoring_instances = [
  {
    name        = "prod-db"
    conn_str    = "postgresql://monitor:pass@db.example.com:5432/postgres"
    environment = "production"
    cluster     = "main"
    node_name   = "primary"
  }
]
```

## Management

### SSH access

```bash
terraform output ssh_command
# Or directly:
ssh -i ~/.ssh/postgres-ai-key.pem ubuntu@$(terraform output -raw external_ip)
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

Method 1: Update `terraform.tfvars` and apply changes:
```bash
# Edit terraform.tfvars, add to monitoring_instances array
terraform apply
# Automatically updates instances.yml and restarts pgwatch services
```

Method 2: Manual configuration (avoids credentials in state):
```bash
ssh ubuntu@your-ip
cd /home/postgres_ai/postgres_ai
sudo -u postgres_ai vim instances.yml
sudo -u postgres_ai ./postgres_ai update-config
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
instance_type = "t3.small"  # 2 vCPU, 2 GiB RAM
```

Suitable for:
- Monitoring 1-2 small databases
- Dev/test environments
- Proof of concept

```hcl
instance_type = "t3.medium"  # 2 vCPU, 4 GiB RAM
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

## Storage options

### Volume types

```hcl
# SSD (recommended for production)
data_volume_type = "gp3"  # General Purpose SSD
root_volume_type = "gp3"

# HDD (lower cost for testing)
data_volume_type = "st1"  # Throughput Optimized HDD (min 125 GiB)
data_volume_type = "sc1"  # Cold HDD (min 125 GiB)
```

### Volume sizing

```hcl
data_volume_size = 50   # Small deployments
data_volume_size = 100  # Medium deployments
data_volume_size = 500  # Large deployments
```

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
        "ResourceRecords": [{"Value": "'"$(terraform output -raw external_ip)"'"}]
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

## Security considerations

### Credentials in Terraform state

All credentials (passwords, connection strings) are stored in plain text in `terraform.tfstate`. This is acceptable for:
- Development and testing
- One-off monitoring deployments
- When state files are properly secured

For production deployments:
- Use remote state with encryption (S3 + KMS)
- Use environment variables: `export TF_VAR_grafana_password=...`
- Configure monitoring instances manually after deployment (Method 2)
- Store state in private repositories only

### IMDSv2

EC2 instances are configured to require IMDSv2 (Instance Metadata Service v2) for enhanced security against SSRF attacks.

### Cleanup

After destroying infrastructure, remove local state files:
```bash
terraform destroy
rm -rf .terraform/ terraform.tfstate*
```
