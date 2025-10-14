# This file provides automatic instances.yml configuration management
# 
# NOTE: This file is NOT compatible with GCP Marketplace due to provider restrictions
# For Marketplace deployments, this file is automatically excluded from the package
# For regular Terraform deployments, this file enables automatic config updates
#
# To use:
# 1. Keep this file for regular Terraform deployments
# 2. Update monitoring_instances in terraform.tfvars
# 3. Run terraform apply - instances.yml will be automatically updated on the server

# Generate instances.yml from template
# NOTE: local provider is declared in main.tf
resource "local_sensitive_file" "instances_config" {
  content  = templatefile("${path.module}/instances.yml.tpl", {
    monitoring_instances = var.monitoring_instances
    enable_demo_db       = var.enable_demo_db
  })
  filename = "${path.module}/.terraform/instances.yml"
}

# Deploy instances.yml to GCP instance when config changes
resource "terraform_data" "deploy_config" {
  triggers_replace = {
    config_hash = local_sensitive_file.instances_config.content_md5
  }

  depends_on = [google_compute_instance.main, google_compute_disk.data]

  provisioner "remote-exec" {
    inline = [
      "if ! sudo test -f /home/postgres_ai/postgres_ai/postgres_ai; then echo 'Skipping - installation not complete'; exit 0; fi",
      "cat > /tmp/instances.yml << 'EOF'",
      local_sensitive_file.instances_config.content,
      "EOF",
      "sudo mv /tmp/instances.yml /home/postgres_ai/postgres_ai/instances.yml",
      "sudo chown postgres_ai:postgres_ai /home/postgres_ai/postgres_ai/instances.yml",
      "sudo -u postgres_ai /home/postgres_ai/postgres_ai/postgres_ai update-config",
      "echo 'Config updated successfully'"
    ]
    
    connection {
      type = "ssh"
      user = "ubuntu"
      host = var.use_static_ip ? google_compute_address.main[0].address : google_compute_instance.main.network_interface[0].access_config[0].nat_ip
    }
  }
}

