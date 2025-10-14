output "instance_name" {
  description = "Name of the Compute Engine instance"
  value       = google_compute_instance.main.name
}

output "instance_id" {
  description = "Compute Engine instance ID"
  value       = google_compute_instance.main.id
}

output "external_ip" {
  description = "External IP address"
  value       = var.use_static_ip ? google_compute_address.main[0].address : google_compute_instance.main.network_interface[0].access_config[0].nat_ip
}

output "public_ip" {
  description = "Public IP address (alias for external_ip)"
  value       = var.use_static_ip ? google_compute_address.main[0].address : google_compute_instance.main.network_interface[0].access_config[0].nat_ip
}

output "grafana_url" {
  description = "Grafana URL"
  value       = "http://${var.use_static_ip ? google_compute_address.main[0].address : google_compute_instance.main.network_interface[0].access_config[0].nat_ip}:3000"
}

output "ssh_command" {
  description = "SSH command to connect"
  value       = "gcloud compute ssh ubuntu@${google_compute_instance.main.name} --zone=${local.zone}"
}

output "data_disk_name" {
  description = "Name of the data disk"
  value       = google_compute_disk.data.name
}

output "data_disk_id" {
  description = "Data disk ID (for snapshots)"
  value       = google_compute_disk.data.id
}

output "grafana_credentials" {
  description = "Grafana credentials"
  value = {
    username = "monitor"
    password = var.grafana_password
  }
  sensitive = true
}

output "grafana_access_hint" {
  description = "How to access Grafana based on your configuration"
  value = var.grafana_bind_host == "127.0.0.1:" || length(var.grafana_source_ranges) == 0 ? (
    <<-EOT

  Grafana Access: SSH Tunnel Required

  Your configuration disables direct access (grafana_bind_host is localhost or no source ranges specified).

  Step 1: Create SSH tunnel
    gcloud compute ssh ubuntu@${google_compute_instance.main.name} --zone=${local.zone} -- -NL 3000:localhost:3000

  Step 2: Open browser
    http://localhost:3000

  Login:
    Username: monitor
    Password: (see terraform.tfvars / Marketplace input)

  EOT
  ) : (
    <<-EOT

  Grafana Access: Direct URL

  Your configuration allows direct access.

  URL: http://${var.use_static_ip ? google_compute_address.main[0].address : google_compute_instance.main.network_interface[0].access_config[0].nat_ip}:3000

  Login:
    Username: monitor
    Password: (see terraform.tfvars / Marketplace input)

  Allowed from: ${join(", ", var.grafana_source_ranges)}

  EOT
  )
}

output "deployment_info" {
  description = "Deployment information"
  value = {
    machine_type       = var.machine_type
    region             = var.region
    zone               = local.zone
    external_ip        = var.use_static_ip ? google_compute_address.main[0].address : google_compute_instance.main.network_interface[0].access_config[0].nat_ip
    data_volume        = "${var.data_volume_size} GiB"
    api_key_configured = var.postgres_ai_api_key != ""
    demo_mode          = var.enable_demo_db
    monitoring_instances = length(var.monitoring_instances)
  }
  sensitive = true
}

output "next_steps" {
  description = "Next steps after deployment"
  value = var.grafana_bind_host == "127.0.0.1:" || length(var.grafana_source_ranges) == 0 ? (
    <<-EOT

Deployment complete

Grafana Access: SSH Tunnel Required
  Step 1: gcloud compute ssh ubuntu@${google_compute_instance.main.name} --zone=${local.zone} -- -NL 3000:localhost:3000
  Step 2: Open http://localhost:3000
  Login: monitor / (see configuration)

Monitoring: ${length(var.monitoring_instances)} instance(s) configured

SSH: gcloud compute ssh ubuntu@${google_compute_instance.main.name} --zone=${local.zone}

For detailed access instructions: terraform output grafana_access_hint
For deployment info: terraform output deployment_info

${length(var.monitoring_instances) == 0 ? "To configure monitoring instances (Marketplace deployments):\n1. SSH to the instance\n2. Edit /home/postgres_ai/postgres_ai/instances.yml\n3. Run: sudo -u postgres_ai /home/postgres_ai/postgres_ai/postgres_ai update-config" : ""}

EOT
  ) : (
    <<-EOT

Deployment complete

Grafana URL: http://${var.use_static_ip ? google_compute_address.main[0].address : google_compute_instance.main.network_interface[0].access_config[0].nat_ip}:3000
  Username: monitor
  Password: see configuration
  Allowed from: ${join(", ", var.grafana_source_ranges)}

Monitoring: ${length(var.monitoring_instances)} instance(s) configured

SSH: gcloud compute ssh ubuntu@${google_compute_instance.main.name} --zone=${local.zone}

For detailed access instructions: terraform output grafana_access_hint
For deployment info: terraform output deployment_info

${length(var.monitoring_instances) == 0 ? "To configure monitoring instances (Marketplace deployments):\n1. SSH to the instance\n2. Edit /home/postgres_ai/postgres_ai/instances.yml\n3. Run: sudo -u postgres_ai /home/postgres_ai/postgres_ai/postgres_ai update-config" : ""}

EOT
  )
  sensitive = false
}

