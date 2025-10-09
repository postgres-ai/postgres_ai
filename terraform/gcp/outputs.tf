output "instance_name" {
  description = "Name of the Compute Engine instance"
  value       = google_compute_instance.main.name
}

output "external_ip" {
  description = "External IP address"
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

output "grafana_credentials" {
  description = "Grafana credentials"
  value = {
    username = "monitor"
    password = var.grafana_password
  }
  sensitive = true
}

output "deployment_info" {
  description = "Deployment information"
  value = {
    machine_type         = var.machine_type
    region               = var.region
    zone                 = local.zone
    external_ip          = var.use_static_ip ? google_compute_address.main[0].address : google_compute_instance.main.network_interface[0].access_config[0].nat_ip
    data_volume          = "${var.data_volume_size} GiB"
    api_key_configured   = var.postgres_ai_api_key != ""
    monitoring_instances = length(var.monitoring_instances)
    demo_mode            = var.enable_demo_db
  }
  sensitive = true
}

output "next_steps" {
  description = "Next steps after deployment"
  value       = <<-EOT

Deployment complete

Grafana URL: http://${var.use_static_ip ? google_compute_address.main[0].address : google_compute_instance.main.network_interface[0].access_config[0].nat_ip}:3000
Username: monitor
Password: see terraform.tfvars

Monitoring: ${length(var.monitoring_instances)} instance(s)
API key: see terraform.tfvars

SSH: gcloud compute ssh ubuntu@${google_compute_instance.main.name} --zone=${local.zone}

For detailed deployment info: terraform output deployment_info

EOT
}

