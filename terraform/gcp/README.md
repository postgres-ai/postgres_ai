# GCP deployment for postgres_ai monitoring

Deploy postgres_ai monitoring stack on Google Cloud Platform using Compute Engine.

> **Note for GCP Marketplace users**: After deployment from Marketplace, monitoring instances must be configured manually (see "Configure monitoring instances" section below).

## Architecture

Single Compute Engine instance running Docker Compose with all monitoring components:
- Grafana for visualization
- Prometheus for metrics storage
- PGWatch for Postgres monitoring
- Flask API for data export
- PostgresAI reporter for automated reports

## Prerequisites

1. **GCP account** with active project
2. **gcloud CLI** installed and configured
3. **Terraform** >= 1.0 installed
4. **SSH key pair** for instance access

### Install gcloud CLI

```bash
# macOS
brew install google-cloud-sdk

# Ubuntu/Debian
curl https://sdk.cloud.google.com | bash

# Authenticate
gcloud auth login
gcloud auth application-default login
```

### Set up GCP project

```bash
# List projects
gcloud projects list

# Set active project
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable compute.googleapis.com
```

## Quick start

See [QUICKSTART.md](QUICKSTART.md) for step-by-step deployment guide.

## Configuration

### Required variables

| Variable | Description | Example |
|----------|-------------|---------|
| `project_id` | GCP project ID | `my-project-123456` |
| `ssh_public_key` | SSH public key | `ssh-rsa AAAA...` |

### Optional variables

| Variable | Description | Default |
|----------|-------------|---------|
| `region` | GCP region | `us-central1` |
| `zone` | GCP zone | First available |
| `environment` | Environment name | `production` |
| `machine_type` | Instance type | `e2-medium` |
| `data_volume_size` | Data disk size (GiB) | `50` |
| `grafana_password` | Grafana password | `demo` |
| `postgres_ai_api_key` | API key for reports | `""` |
| `use_static_ip` | Use static IP | `true` |
| `enable_demo_db` | Enable demo database | `false` |

### Machine types

| Type | vCPU | RAM | Database count |
|------|------|-----|----------------|
| `e2-medium` | 2 | 4 GiB | 1-3 |
| `e2-standard-2` | 2 | 8 GiB | 3-10 (recommended) |
| `e2-standard-4` | 4 | 16 GiB | 10+ |

## Deployment

### 1. Configure variables

```bash
cd terraform/gcp
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
project_id = "my-project-123456"
region = "us-central1"

ssh_public_key = "ssh-rsa AAAA... user@hostname"
grafana_password = "secure-password"

monitoring_instances = [
  {
    name = "prod-db"
    conn_str = "host=10.0.0.5 port=5432 user=monitor dbname=postgres password=pass sslmode=require"
    environment = "production"
    cluster = "main"
    node_name = "primary"
  }
]
```

### 2. Validate configuration

```bash
./validate.sh
```

### 3. Deploy

```bash
terraform init
terraform plan
terraform apply
```

### 4. Access Grafana

```bash
# Get outputs
terraform output grafana_url
terraform output -json grafana_credentials

# SSH to instance
gcloud compute ssh ubuntu@production-postgres-ai-monitoring --zone=us-central1-a
```

## Configure monitoring instances

### Method 1: Terraform (before deployment)

Add to `terraform.tfvars`:

```hcl
monitoring_instances = [
  {
    name = "my-db"
    conn_str = "postgresql://monitoring:password@host:5432/postgres"
    environment = "production"
    cluster = "main"
    node_name = "primary"
  }
]
```

Deploy:
```bash
terraform apply
```

### Method 2: Manual (after deployment, for Marketplace)

1. Create monitoring user on your Postgres instance:

```sql
create user monitoring with password 'secure_password';
grant pg_monitor to monitoring;
grant connect on database postgres to monitoring;
```

2. SSH to monitoring instance:

```bash
gcloud compute ssh ubuntu@<instance-name> --zone=<zone>
```

3. Edit instances.yml:

```bash
sudo -u postgres_ai vim /home/postgres_ai/postgres_ai/instances.yml
```

Add your instances:

```yaml
- name: my-db
  conn_str: postgresql://monitoring:password@host:5432/postgres
  preset_metrics: full
  custom_metrics:
    ts_enabled: true
  group: default
  custom_tags:
    env: production
    cluster: main
    node_name: primary
```

4. Apply configuration:

```bash
sudo -u postgres_ai /home/postgres_ai/postgres_ai/postgres_ai update-config
```

### PostgresAI reports

Configure API key:

```hcl
postgres_ai_api_key = "your-api-key"
```

Reports are automatically generated and uploaded to PostgresAI platform.

## Maintenance

### Backup data

```bash
# Create snapshot
gcloud compute disks snapshot production-postgres-ai-data \
  --zone=us-central1-a \
  --snapshot-names=postgres-ai-backup-$(date +%Y%m%d)

# Restore from snapshot
gcloud compute disks create postgres-ai-data-restored \
  --source-snapshot=postgres-ai-backup-20250101 \
  --zone=us-central1-a
```

### Update monitoring instances

Edit `terraform.tfvars` and run:

```bash
terraform apply
```

### View logs

```bash
# SSH to instance
gcloud compute ssh ubuntu@production-postgres-ai-monitoring --zone=us-central1-a

# View startup logs
sudo tail -f /var/log/startup-script.log

# View service logs
sudo journalctl -u postgres-ai -f

# View container logs
sudo docker-compose logs -f
```

### Restart services

```bash
sudo systemctl restart postgres-ai
```

## Network configuration

### Restrict access

For production, limit SSH and Grafana access:

```hcl
ssh_source_ranges = ["203.0.113.0/24"]
grafana_source_ranges = ["203.0.113.0/24"]
```

### VPC peering

To monitor databases in another VPC:

1. Set up VPC peering in GCP Console
2. Update firewall rules to allow monitoring traffic
3. Use private IPs in connection strings

## Troubleshooting

### Services not starting

```bash
# Check startup script
sudo tail -100 /var/log/startup-script.log

# Check service status
sudo systemctl status postgres-ai

# Check Docker
sudo docker ps -a
sudo docker-compose logs
```

### Cannot connect to Grafana

```bash
# Check firewall rules
gcloud compute firewall-rules list | grep postgres-ai

# Check instance external IP
gcloud compute instances describe production-postgres-ai-monitoring \
  --zone=us-central1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

### Disk not mounted

```bash
# Check disk attachment
lsblk

# Check fstab
cat /etc/fstab

# Manually mount
sudo mount /dev/disk/by-id/google-data-disk /mnt/data
```

## Cleanup

To destroy all resources:

```bash
terraform destroy
```

Note: Persistent disk snapshots must be deleted manually.

## Support

For issues and questions:
- GitHub Issues: https://github.com/postgres-ai/postgres_ai/issues
- Documentation: https://postgres.ai/docs

