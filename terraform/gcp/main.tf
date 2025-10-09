terraform {
  required_version = ">= 1.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Get available zones
data "google_compute_zones" "available" {
  region = var.region
  status = "UP"
}

locals {
  zone = var.zone != "" ? var.zone : data.google_compute_zones.available.names[0]
  common_tags = {
    environment = var.environment
    managed_by  = "terraform"
    project     = "postgres-ai-monitoring"
  }
}

# VPC Network
resource "google_compute_network" "main" {
  name                    = "${var.environment}-postgres-ai-network"
  auto_create_subnetworks = false
}

# Subnet
resource "google_compute_subnetwork" "main" {
  name          = "${var.environment}-postgres-ai-subnet"
  ip_cidr_range = var.subnet_cidr
  region        = var.region
  network       = google_compute_network.main.id
}

# Firewall rules
resource "google_compute_firewall" "ssh" {
  name    = "${var.environment}-postgres-ai-allow-ssh"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = var.ssh_source_ranges
  target_tags   = ["postgres-ai-monitoring"]
}

resource "google_compute_firewall" "grafana" {
  name    = "${var.environment}-postgres-ai-allow-grafana"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["3000"]
  }

  source_ranges = var.grafana_source_ranges
  target_tags   = ["postgres-ai-monitoring"]
}

# Data disk
resource "google_compute_disk" "data" {
  name = "${var.environment}-postgres-ai-data"
  type = var.data_disk_type
  zone = local.zone
  size = var.data_volume_size

  labels = local.common_tags
}

# Static external IP (optional)
resource "google_compute_address" "main" {
  count = var.use_static_ip ? 1 : 0

  name   = "${var.environment}-postgres-ai-ip"
  region = var.region
}

# Compute Engine instance
resource "google_compute_instance" "main" {
  name         = "${var.environment}-postgres-ai-monitoring"
  machine_type = var.machine_type
  zone         = local.zone

  tags = ["postgres-ai-monitoring"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 30
      type  = var.boot_disk_type
    }
  }

  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "data-disk"
  }

  network_interface {
    network    = google_compute_network.main.id
    subnetwork = google_compute_subnetwork.main.id

    dynamic "access_config" {
      for_each = var.use_static_ip ? [1] : [1]
      content {
        nat_ip = var.use_static_ip ? google_compute_address.main[0].address : null
      }
    }
  }

  metadata = {
    ssh-keys = var.ssh_public_key != "" ? "ubuntu:${var.ssh_public_key}" : ""
  }

  metadata_startup_script = templatefile("${path.module}/user_data.sh", {
    grafana_password     = var.grafana_password
    postgres_ai_api_key  = var.postgres_ai_api_key
    monitoring_instances = var.monitoring_instances
    enable_demo_db       = var.enable_demo_db
  })

  labels = local.common_tags

  service_account {
    scopes = ["cloud-platform"]
  }

  allow_stopping_for_update = true
}

# Generate instances.yml from template
resource "local_file" "instances_config" {
  content = templatefile("${path.module}/instances.yml.tpl", {
    monitoring_instances = var.monitoring_instances
    enable_demo_db       = var.enable_demo_db
  })
  filename = "${path.module}/.terraform/instances.yml"
}

# Deploy instances.yml to GCP instance when config changes
resource "terraform_data" "deploy_config" {
  triggers_replace = {
    config_hash = local_file.instances_config.content_md5
  }

  depends_on = [google_compute_instance.main, google_compute_disk.data]

  provisioner "remote-exec" {
    inline = [
      "if ! sudo test -f /home/postgres_ai/postgres_ai/postgres_ai; then echo 'Skipping - installation not complete'; exit 0; fi",
      "cat > /tmp/instances.yml << 'EOF'",
      local_file.instances_config.content,
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

