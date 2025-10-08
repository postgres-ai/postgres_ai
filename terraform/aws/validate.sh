#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "Validating Terraform configuration..."
echo

# Check terraform
if ! command -v terraform &> /dev/null; then
    echo -e "${RED}ERROR: Terraform not installed${NC}"
    exit 1
fi
echo -e "${GREEN}OK${NC} Terraform $(terraform version -json | grep -o '"version":"[^"]*' | cut -d'"' -f4)"

# Check AWS CLI
if command -v aws &> /dev/null && aws sts get-caller-identity &> /dev/null 2>&1; then
    ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
    echo -e "${GREEN}OK${NC} AWS credentials (Account: $ACCOUNT)"
else
    echo -e "${YELLOW}WARN${NC} AWS credentials not configured"
fi

# Init
terraform init -backend=false > /dev/null 2>&1 || { echo -e "${RED}ERROR: Terraform init failed${NC}"; exit 1; }
echo -e "${GREEN}OK${NC} Terraform init"

# Validate
terraform validate > /dev/null 2>&1 || { echo -e "${RED}ERROR: Validation failed${NC}"; terraform validate; exit 1; }
echo -e "${GREEN}OK${NC} Configuration valid"

# Check terraform.tfvars
if [ ! -f "terraform.tfvars" ]; then
    echo -e "${RED}ERROR: terraform.tfvars not found${NC}"
    echo "Run: cp terraform.tfvars.example terraform.tfvars"
    exit 1
fi

# Check required variables
grep -q "ssh_key_name.*=" terraform.tfvars && ! grep -q 'ssh_key_name.*=.*""' terraform.tfvars || \
    { echo -e "${RED}ERROR: ssh_key_name not set in terraform.tfvars${NC}"; exit 1; }

echo -e "${GREEN}OK${NC} Required variables configured"

# Plan
echo
echo "Running terraform plan..."
if terraform plan -out=tfplan > /tmp/tfplan.log 2>&1; then
    RESOURCES=$(terraform show -json tfplan 2>/dev/null | grep -o '"to_create":[0-9]*' | cut -d: -f2)
    echo -e "${GREEN}OK${NC} Plan successful (${RESOURCES} resources to create)"
else
    echo -e "${RED}ERROR: Plan failed${NC}"
    cat /tmp/tfplan.log
    exit 1
fi

echo
echo "Validation complete. Ready to deploy."
echo "Run: terraform apply tfplan"
echo
