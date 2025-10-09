# Terraform deployment modules

Infrastructure as Code modules for deploying postgres_ai monitoring to cloud providers.

## Available modules

### AWS (EC2)
Single EC2 instance deployment with Docker Compose.

- **Path**: `aws/`
- **Architecture**: Single EC2 instance with Docker Compose
- **Best for**: Small to medium deployments (1-10 databases)
- **Documentation**: [aws/README.md](aws/README.md)

### GCP (Compute Engine)
Single Compute Engine instance deployment with Docker Compose.

- **Path**: `gcp/`
- **Architecture**: Single Compute Engine instance with Docker Compose
- **Best for**: Small to medium deployments (1-10 databases)
- **Documentation**: [gcp/README.md](gcp/README.md)

### Azure (Coming soon)
Deploy to Microsoft Azure using Virtual Machines or Container Instances.

## Quick start

### AWS deployment

```bash
cd terraform/aws

# Copy example variables
cp terraform.tfvars.example terraform.tfvars

# Edit variables with your settings
vim terraform.tfvars

# Initialize Terraform
terraform init

# Review the plan
terraform plan

# Deploy infrastructure (takes 5-10 minutes)
terraform apply
```

### GCP deployment

```bash
cd terraform/gcp

# Authenticate with GCP
gcloud auth login
gcloud auth application-default login

# Copy example variables
cp terraform.tfvars.example terraform.tfvars

# Edit variables with your settings
vim terraform.tfvars

# Initialize Terraform
terraform init

# Review the plan
terraform plan

# Deploy infrastructure (takes 5-10 minutes)
terraform apply
```

## Architecture overview

Both AWS and GCP deployments follow similar architecture:

1. **Compute**
   - AWS: Single EC2 instance (t3.medium default)
   - GCP: Single Compute Engine instance (e2-medium default)
   - Ubuntu 22.04 LTS with Docker and Docker Compose
   - Systemd service for automatic startup

2. **Storage**
   - AWS: EBS volume for persistent data
   - GCP: Persistent disk for data storage
   - Automated snapshots available

3. **Networking**
   - Virtual network with public subnet
   - Firewall rules for SSH and Grafana access
   - Optional static IP for stable addressing

4. **Monitoring stack**
   - Runs docker-compose from cloned repository
   - Grafana accessible on port 3000

## Security considerations

- Instances deployed in public subnet
- Firewall rules restrict access to SSH and Grafana only
- All data encrypted at rest
- AWS: Use Systems Manager Session Manager instead of SSH
- GCP: Use IAP for SSH tunneling instead of public SSH
- Recommended: Restrict source IP ranges to your office/VPN IP

## Instance types

### AWS

- **t3.medium**: 2 vCPU, 4 GiB RAM - suitable for 1-3 databases (default)
- **t3.large**: 2 vCPU, 8 GiB RAM - suitable for 3-10 databases
- **t3.xlarge**: 4 vCPU, 16 GiB RAM - suitable for 10+ databases

### GCP

- **e2-medium**: 2 vCPU, 4 GiB RAM - suitable for 1-3 databases (default)
- **e2-standard-2**: 2 vCPU, 8 GiB RAM - suitable for 3-10 databases
- **e2-standard-4**: 4 vCPU, 16 GiB RAM - suitable for 10+ databases

## Support

For issues or questions:
- Open an issue on GitLab
- Contact PostgresAI support
- Check documentation at https://postgres.ai

