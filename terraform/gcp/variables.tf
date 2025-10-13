variable "goog_cm_deployment_name" {
  description = "Deployment name from GCP Marketplace (auto-generated)"
  type        = string
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
}

variable "zone" {
  description = "GCP zone (optional, defaults to first available zone in region)"
  type        = string
  default     = ""
}

variable "environment" {
  description = "Environment name"
  type        = string
}

variable "machine_type" {
  description = "Compute Engine machine type"
  type        = string
}

variable "data_volume_size" {
  description = "Size of persistent data disk in GiB"
  type        = number
}

variable "data_disk_type" {
  description = "Type of data disk (pd-standard for HDD, pd-ssd for SSD, pd-balanced for balanced)"
  type        = string
}

variable "boot_disk_type" {
  description = "Type of boot disk (pd-standard for HDD, pd-ssd for SSD, pd-balanced for balanced)"
  type        = string
}

variable "boot_disk_size" {
  description = "Boot disk size in GiB"
  type        = number
  default     = 30
}

variable "source_image" {
  description = "GCE image for boot disk (leave empty outside Marketplace)"
  type        = string
  default     = "projects/postgresai-public-374205/global/images/postgres-ai-monitoring-0-9-x86-64-20251010"
}

variable "subnet_cidr" {
  description = "CIDR block for subnet"
  type        = string
}

variable "ssh_source_ranges" {
  description = "CIDR blocks allowed to SSH"
  type        = list(string)
}

variable "grafana_source_ranges" {
  description = "CIDR blocks allowed to access Grafana"
  type        = list(string)
}

variable "use_static_ip" {
  description = "Use static external IP address"
  type        = bool
}

variable "ssh_public_key" {
  description = "SSH public key for instance access"
  type        = string
}

variable "grafana_password" {
  description = "Grafana admin password (optional, defaults to 'demo')"
  type        = string
  sensitive   = true
}

variable "postgres_ai_api_key" {
  description = "PostgresAI API key for report uploads"
  type        = string
  default     = ""
  sensitive   = true
}

variable "enable_demo_db" {
  description = "Enable demo Postgres database for testing"
  type        = bool
  default     = false
}

variable "postgres_ai_version" {
  description = "postgres_ai version (git tag or branch)"
  type        = string
  default     = "main"
}

variable "monitoring_instances" {
  description = "List of Postgres instances to monitor"
  type = list(object({
    name        = string
    conn_str    = string
    environment = string
    cluster     = string
    node_name   = string
  }))
  default = []
}

