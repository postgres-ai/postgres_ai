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

## Deploy

```bash
cd terraform/aws

# Configure
cp terraform.tfvars.example terraform.tfvars
vim terraform.tfvars  # Set ssh_key_name 

# Validate
./validate.sh

# Deploy
terraform init
terraform plan
terraform apply

# Get access info
terraform output grafana_url
terraform output ssh_command
```

## Access

```bash
# Grafana dashboard
open $(terraform output -raw grafana_url)
# Login: monitor / demo (or your custom password)

# SSH
ssh -i ~/.ssh/postgres-ai-key.pem ubuntu@$(terraform output -raw public_ip)
```

## Add monitoring instances

Edit `terraform.tfvars`:

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

Apply changes:
```bash
terraform apply
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

