output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.main.id
}

output "data_volume_id" {
  description = "EBS data volume ID (for snapshots)"
  value       = aws_ebs_volume.data.id
}

output "public_ip" {
  description = "Public IP address"
  value       = var.use_elastic_ip ? aws_eip.main[0].public_ip : aws_instance.main.public_ip
}

output "grafana_url" {
  description = "Grafana dashboard URL"
  value       = "http://${var.use_elastic_ip ? aws_eip.main[0].public_ip : aws_instance.main.public_ip}:3000"
}

output "ssh_command" {
  description = "SSH command to connect"
  value       = "ssh -i ~/.ssh/${var.ssh_key_name}.pem ubuntu@${var.use_elastic_ip ? aws_eip.main[0].public_ip : aws_instance.main.public_ip}"
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
    instance_type        = var.instance_type
    region               = var.aws_region
    public_ip            = var.use_elastic_ip ? aws_eip.main[0].public_ip : aws_instance.main.public_ip
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

Grafana URL: http://${var.use_elastic_ip ? aws_eip.main[0].public_ip : aws_instance.main.public_ip}:3000
Username: monitor
Password: see terraform.tfvars

Monitoring: ${length(var.monitoring_instances)} instance(s)
API key: see terraform.tfvars

SSH: ssh -i ~/.ssh/${var.ssh_key_name}.pem ubuntu@${var.use_elastic_ip ? aws_eip.main[0].public_ip : aws_instance.main.public_ip}

For detailed deployment info: terraform output deployment_info

EOT
}

