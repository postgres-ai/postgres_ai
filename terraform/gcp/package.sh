#!/bin/bash
set -euo pipefail

# Package Terraform module for GCP Marketplace

VERSION="${1:-0.9}"
OUTPUT_DIR="${2:-./dist}"
PACKAGE_NAME="postgres-ai-monitoring-terraform-${VERSION}.zip"

echo "Package PostgresAI Monitoring"
echo "Version: ${VERSION}"
echo "Output: ${OUTPUT_DIR}/${PACKAGE_NAME}"

# Regenerate metadata
if command -v cft >/dev/null 2>&1; then
  echo "Regenerate metadata"
  cft blueprint metadata -d . -o metadata.yaml
  cft blueprint metadata -d . -o metadata.display.yaml --display
fi

# Create output directory
mkdir -p "${OUTPUT_DIR}"

# Create temporary directory for packaging
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "${TEMP_DIR}"' EXIT

echo "Copy files"
cp main.tf "${TEMP_DIR}/"
cp variables.tf "${TEMP_DIR}/"
cp outputs.tf "${TEMP_DIR}/"
cp user_data.sh "${TEMP_DIR}/"
cp instances.yml.tpl "${TEMP_DIR}/"
cp metadata.yaml "${TEMP_DIR}/"
cp metadata.display.yaml "${TEMP_DIR}/"
cp README.md "${TEMP_DIR}/" || true
cp validate.sh "${TEMP_DIR}/" || true
cp marketplace_test.tfvars "$TEMP_DIR/" || true

# NOTE: config_management.tf is intentionally excluded from Marketplace package
# It contains local and terraform_data providers which are not allowed in GCP Marketplace
# For regular Terraform deployments, use config_management.tf from the source repository

# Include example tfvars if present
if [[ -f terraform.tfvars.example ]]; then
  cp terraform.tfvars.example "${TEMP_DIR}/"
fi

# Minimal provider example
cat > "${TEMP_DIR}/provider.tf.example" << 'EOF'
terraform {
  required_version = ">= 1.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
EOF

echo "Create ZIP"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_PATH="${SCRIPT_DIR}/${OUTPUT_DIR}"
mkdir -p "${OUTPUT_PATH}"

pushd "${TEMP_DIR}" >/dev/null
zip -r "${OUTPUT_PATH}/${PACKAGE_NAME}" * -x ".*"
popd >/dev/null

echo "Created: ${OUTPUT_PATH}/${PACKAGE_NAME}"

