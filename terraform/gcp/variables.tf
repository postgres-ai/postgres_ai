variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone (optional, defaults to first available zone in region)"
  type        = string
  default     = ""
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "machine_type" {
  description = "Compute Engine machine type"
  type        = string
  default     = "e2-medium"
}

variable "data_volume_size" {
  description = "Size of persistent data disk in GiB"
  type        = number
  default     = 50
}

variable "data_disk_type" {
  description = "Type of data disk (pd-standard for HDD, pd-ssd for SSD, pd-balanced for balanced)"
  type        = string
  default     = "pd-standard"
}

variable "boot_disk_type" {
  description = "Type of boot disk (pd-standard for HDD, pd-ssd for SSD, pd-balanced for balanced)"
  type        = string
  default     = "pd-standard"
}

variable "subnet_cidr" {
  description = "CIDR block for subnet"
  type        = string
  default     = "10.0.1.0/24"
}

variable "ssh_source_ranges" {
  description = "CIDR blocks allowed to SSH"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "grafana_source_ranges" {
  description = "CIDR blocks allowed to access Grafana"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "use_static_ip" {
  description = "Use static external IP address"
  type        = bool
  default     = true
}

variable "ssh_public_key" {
  description = "SSH public key for instance access"
  type        = string
  default     = ""
}

variable "grafana_password" {
  description = "Grafana admin password (optional, defaults to 'demo')"
  type        = string
  default     = "demo"
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

