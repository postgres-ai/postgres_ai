terraform {
  required_version = ">= 1.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    # local provider needed for config_management.tf (excluded from Marketplace package)
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

locals {
  zone = var.zone != "" ? var.zone : "${var.region}-a"
  common_tags = {
    environment = var.environment
    managed_by  = "terraform"
    project     = "postgres-ai-monitoring"
  }
}

# VPC Network
resource "google_compute_network" "main" {
  name                    = "${var.goog_cm_deployment_name}-network"
  auto_create_subnetworks = false
}

# Subnet
resource "google_compute_subnetwork" "main" {
  name          = "${var.goog_cm_deployment_name}-subnet"
  ip_cidr_range = var.subnet_cidr
  region        = var.region
  network       = google_compute_network.main.id
}

# Firewall rules
resource "google_compute_firewall" "ssh" {
  name    = "${var.goog_cm_deployment_name}-allow-ssh"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = var.ssh_source_ranges
  target_tags   = ["postgres-ai-monitoring"]
}

resource "google_compute_firewall" "grafana" {
  name    = "${var.goog_cm_deployment_name}-allow-grafana"
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
  name = "${var.goog_cm_deployment_name}-data"
  type = var.data_disk_type
  zone = local.zone
  size = var.data_volume_size

  labels = local.common_tags
}

# Static external IP (optional)
resource "google_compute_address" "main" {
  count = var.use_static_ip ? 1 : 0

  name   = "${var.goog_cm_deployment_name}-ip"
  region = var.region
}

# Compute Engine instance
resource "google_compute_instance" "main" {
  name         = "${var.goog_cm_deployment_name}-vm"
  machine_type = var.machine_type
  zone         = local.zone

  tags = ["postgres-ai-monitoring"]

  boot_disk {
    initialize_params {
      image = var.source_image != "" ? var.source_image : "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = var.boot_disk_size
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
    grafana_password       = var.grafana_password
    postgres_ai_api_key    = var.postgres_ai_api_key
    enable_demo_db         = var.enable_demo_db
    postgres_ai_version    = var.postgres_ai_version
    bind_host              = var.bind_host
    grafana_bind_host      = var.grafana_bind_host
    db_connection_string   = var.db_connection_string
    db_password            = var.db_password
    environment            = var.environment
    instances_yml          = templatefile("${path.module}/instances.yml.tpl", {
      monitoring_instances = var.monitoring_instances
      enable_demo_db       = var.enable_demo_db
    })
  })

  labels = local.common_tags

  service_account {
    scopes = ["cloud-platform"]
  }

  allow_stopping_for_update = true
}


