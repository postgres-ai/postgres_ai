# Quick start guide for GCP deployment

Step-by-step guide to deploy postgres_ai monitoring on GCP.

## Prerequisites

1. GCP account with active project
2. gcloud CLI installed
3. Terraform installed
4. SSH key generated

## Step 1: Install tools

### Install gcloud CLI

macOS:
```bash
brew install google-cloud-sdk
```

Ubuntu/Debian:
```bash
curl https://sdk.cloud.google.com | bash
```

### Authenticate

```bash
gcloud auth login
gcloud auth application-default login
```

### Set project

```bash
# List your projects
gcloud projects list

# Set active project
gcloud config set project YOUR_PROJECT_ID
```

### Enable APIs

```bash
gcloud services enable compute.googleapis.com
```

### Install Terraform

macOS:
```bash
brew install terraform
```

Ubuntu/Debian:
```bash
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install terraform
```

## Step 2: Generate SSH key

If you don't have an SSH key:

```bash
ssh-keygen -t rsa -b 4096 -f ~/.ssh/gcp_postgres_ai
```

Get your public key:

```bash
cat ~/.ssh/gcp_postgres_ai.pub
```

## Step 3: Configure deployment

```bash
cd terraform/gcp
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
# Required
project_id = "your-gcp-project-id"
ssh_public_key = "ssh-rsa AAAAB3NzaC1... user@hostname"

# Optional
region = "us-central1"
grafana_password = "your-secure-password"
machine_type = "e2-standard-2"
data_volume_size = 50
```

## Step 4: Add monitoring instances

Get your Postgres connection details and add to `terraform.tfvars`:

```hcl
monitoring_instances = [
  {
    name = "production-db-1"
    conn_str = "host=10.0.0.5 port=5432 user=monitoring dbname=postgres password=mon_pass sslmode=require"
    environment = "production"
    cluster = "main"
    node_name = "primary"
  }
]
```

## Step 5: Validate and deploy

```bash
# Validate configuration
./validate.sh

# Initialize Terraform
terraform init

# Review changes
terraform plan

# Deploy
terraform apply
```

Type `yes` when prompted.

## Step 6: Access Grafana

After deployment completes (3-5 minutes):

```bash
# Get Grafana URL
terraform output grafana_url

# Get credentials
terraform output -json grafana_credentials
```

Open URL in browser and login with:
- Username: `monitor`
- Password: (from terraform.tfvars)

## Step 7: Verify monitoring

1. Open Grafana dashboards
2. Check "Node performance overview"
3. Verify your Postgres instances appear

## Common tasks

### Add more instances

Edit `terraform.tfvars`:

```hcl
monitoring_instances = [
  {
    name = "production-db-1"
    conn_str = "..."
    environment = "production"
    cluster = "main"
    node_name = "primary"
  },
  {
    name = "production-db-2"  # New instance
    conn_str = "..."
    environment = "production"
    cluster = "main"
    node_name = "standby"
  }
]
```

Apply changes:

```bash
terraform apply
```

### SSH to instance

```bash
# Using gcloud
gcloud compute ssh ubuntu@production-postgres-ai-monitoring --zone=us-central1-a

# Using terraform output
terraform output ssh_command
```

### View logs

```bash
# Startup logs
sudo tail -f /var/log/startup-script.log

# Service logs
sudo journalctl -u postgres-ai -f

# Docker logs
sudo docker-compose logs -f
```

### Create backup

```bash
# Get disk name
terraform output data_disk_name

# Create snapshot
gcloud compute disks snapshot production-postgres-ai-data \
  --zone=us-central1-a \
  --snapshot-names=backup-$(date +%Y%m%d)
```

### Update configuration

1. Edit `terraform.tfvars`
2. Run `terraform apply`
3. SSH to instance and restart: `sudo systemctl restart postgres-ai`

### Cleanup

To remove all resources:

```bash
terraform destroy
```

## Troubleshooting

### Cannot access Grafana

Check firewall rules:

```bash
gcloud compute firewall-rules list --filter="name:postgres-ai"
```

Get instance IP:

```bash
terraform output external_ip
```

### Services not running

SSH to instance and check:

```bash
sudo systemctl status postgres-ai
sudo docker ps -a
```

### Connection to Postgres failed

Verify from instance:

```bash
# Test connection
psql "host=10.0.0.5 port=5432 user=monitoring dbname=postgres sslmode=require"
```

Check firewall rules in your Postgres network.

## Next steps

- Configure PostgresAI API key for automated reports
- Set up monitoring alerts in Grafana
- Create regular snapshot schedule
- Review security settings

## Support

- Documentation: https://postgres.ai/docs
- GitHub Issues: https://github.com/postgres-ai/postgres_ai/issues

