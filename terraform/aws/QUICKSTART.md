# Quick start

## Prerequisites

```bash
# Create SSH key
aws ec2 create-key-pair --key-name postgres-ai-key \
  --query 'KeyMaterial' --output text > ~/.ssh/postgres-ai-key.pem
chmod 400 ~/.ssh/postgres-ai-key.pem

# Configure AWS credentials
aws configure
```

## Configure

```bash
cd terraform/aws

# Copy example config
cp terraform.tfvars.example terraform.tfvars
vim terraform.tfvars
```

Uncomment and set all required parameters:
- `ssh_key_name` - your AWS SSH key name
- `aws_region` - AWS region
- `environment` - environment name
- `instance_type` - EC2 instance type (e.g., t3.medium)
- `data_volume_size` - data disk size in GiB
- `data_volume_type` / `root_volume_type` - volume types (gp3, st1, sc1)
- `allowed_ssh_cidr` - CIDR blocks for SSH access (use `["YOUR_IP/32"]`, get IP: `curl ifconfig.me`)
- `allowed_cidr_blocks` - CIDR blocks for Grafana (use `[]` to disable direct access = SSH tunnel only, most secure)
- `use_elastic_ip` - allocate Elastic IP (true/false)
- `grafana_password` - Grafana admin password
- `bind_host` - port binding for internal services (optional, defaults to `"127.0.0.1:"`)

Optional parameters:
- `grafana_bind_host` - Grafana port binding (defaults to `"127.0.0.1:"` for SSH tunnel)
- `postgres_ai_version` - git branch/tag (defaults to "0.10")

## Add monitoring instances

Edit `terraform.tfvars` to add PostgreSQL instances to monitor:

```hcl
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

## Deploy

```bash
# Initialize and validate
terraform init
terraform validate

# Review changes
terraform plan

# Deploy
terraform apply

# Get access info
terraform output grafana_url
terraform output ssh_command
```

## Access

### Grafana

Terraform will show the correct access method after deployment:

```bash
# See access instructions for your configuration
terraform output grafana_access_hint
```

**SSH tunnel access (default):**

```bash
# Create SSH tunnel
ssh -i ~/.ssh/postgres-ai-key.pem -NL 3000:localhost:3000 ubuntu@$(terraform output -raw public_ip)

# Open browser
open http://localhost:3000
# Login: monitor / <password from terraform.tfvars>
```

**Direct access (if configured):**

```bash
# Grafana dashboard
open $(terraform output -raw grafana_url)
# Login: monitor / <password from terraform.tfvars>
```

### SSH

```bash
ssh -i ~/.ssh/postgres-ai-key.pem ubuntu@$(terraform output -raw public_ip)
```

## Operations

```bash
# View logs
ssh ubuntu@IP "sudo cat /var/log/user-data.log"

# Restart services
ssh ubuntu@IP "sudo systemctl restart postgres-ai"

# Destroy
terraform destroy
```

## Troubleshooting

```bash
# Check installation log
ssh ubuntu@IP "sudo cat /var/log/user-data.log"

# Check service status
ssh ubuntu@IP "sudo systemctl status postgres-ai"

# Check containers
ssh ubuntu@IP "sudo docker ps"
```

## Security notes

Credentials (passwords, connection strings) are stored in `terraform.tfstate` in plain text. For one-off/dev deployments this is acceptable if you clean up after `terraform destroy`:

```bash
terraform destroy
rm -rf .terraform/ terraform.tfstate*
```

For production deployments, consider:
- Using environment variables: `export TF_VAR_grafana_password=...`
- Remote state with encryption (S3 + encryption)
- Configuring monitoring instances manually after deployment

