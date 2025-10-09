variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.medium"
}

variable "data_volume_size" {
  description = "Size of EBS data volume in GiB"
  type        = number
  default     = 50
}

variable "data_volume_type" {
  description = "EBS volume type for data disk (gp3 for SSD, st1 for HDD throughput optimized, sc1 for HDD cold)"
  type        = string
  default     = "gp3"
}

variable "root_volume_type" {
  description = "EBS volume type for root disk (gp3 for SSD, gp2 for older SSD)"
  type        = string
  default     = "gp3"
}

variable "ssh_key_name" {
  description = "Name of SSH key pair for EC2 access"
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR blocks allowed for SSH access"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed for Grafana access"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "use_elastic_ip" {
  description = "Allocate Elastic IP for stable address"
  type        = bool
  default     = true
}

variable "grafana_password" {
  description = "Grafana admin password (optional, defaults to 'demo')"
  type        = string
  default     = "demo"
  sensitive   = true
}

variable "postgres_ai_api_key" {
  description = "PostgresAI API key (optional)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "monitoring_instances" {
  description = "PostgreSQL instances to monitor"
  type = list(object({
    name        = string
    conn_str    = string
    environment = string
    cluster     = string
    node_name   = string
  }))
  default = []
}

variable "enable_demo_db" {
  description = "Enable demo database"
  type        = bool
  default     = false
}

