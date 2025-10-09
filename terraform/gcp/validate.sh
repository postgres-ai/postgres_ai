#!/bin/bash
set -e

echo "Validating GCP Terraform configuration..."
echo

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
  echo "Error: gcloud CLI not found"
  echo "Install: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Check if gcloud is authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &> /dev/null; then
  echo "Error: Not authenticated with gcloud"
  echo "Run: gcloud auth login && gcloud auth application-default login"
  exit 1
fi

# Check if Terraform is installed
if ! command -v terraform &> /dev/null; then
  echo "Error: Terraform not found"
  echo "Install: https://www.terraform.io/downloads"
  exit 1
fi

# Check if terraform.tfvars exists
if [ ! -f terraform.tfvars ]; then
  echo "Error: terraform.tfvars not found"
  echo "Run: cp terraform.tfvars.example terraform.tfvars"
  exit 1
fi

# Check required variables
echo "Checking required variables..."

check_var() {
  var_name=$1
  if ! grep -q "^${var_name}\s*=" terraform.tfvars; then
    echo "Error: ${var_name} not set in terraform.tfvars"
    return 1
  fi
  
  value=$(grep "^${var_name}\s*=" terraform.tfvars | cut -d'=' -f2- | tr -d ' "')
  if [ -z "$value" ] || [ "$value" = "your-gcp-project-id" ] || [ "$value" = "ssh-rsaAAAA..." ]; then
    echo "Error: ${var_name} has placeholder value"
    return 1
  fi
  
  return 0
}

if ! check_var "project_id"; then
  echo "Set your GCP project ID"
  exit 1
fi

if ! check_var "ssh_public_key"; then
  echo "Set your SSH public key"
  echo "Get it with: cat ~/.ssh/id_rsa.pub"
  exit 1
fi

# Validate project exists and is accessible
echo "Validating GCP project..."
PROJECT_ID=$(grep "^project_id\s*=" terraform.tfvars | cut -d'=' -f2- | tr -d ' "')
if ! gcloud projects describe "$PROJECT_ID" &> /dev/null; then
  echo "Error: Cannot access project $PROJECT_ID"
  echo "Run: gcloud config set project $PROJECT_ID"
  exit 1
fi

# Check if Compute Engine API is enabled
echo "Checking required APIs..."
if ! gcloud services list --enabled --project="$PROJECT_ID" --filter="name:compute.googleapis.com" --format="value(name)" | grep -q compute; then
  echo "Warning: Compute Engine API not enabled"
  echo "Enable it: gcloud services enable compute.googleapis.com --project=$PROJECT_ID"
fi

# Run terraform commands
echo "Running terraform init..."
terraform init -backend=false > /dev/null

echo "Running terraform validate..."
terraform validate

echo "Running terraform fmt..."
terraform fmt -check

echo
echo "Validation successful"
echo
echo "Next steps:"
echo "1. Review configuration: cat terraform.tfvars"
echo "2. Plan deployment: terraform plan"
echo "3. Deploy: terraform apply"

