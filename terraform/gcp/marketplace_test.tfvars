goog_cm_deployment_name = "test-postgres-ai-monitoring"
project_id              = "test-project-id-ai"
region                  = "us-central1"
zone                    = "us-central1-b"
environment             = "test"
machine_type            = "e2-medium"
data_volume_size        = 50
data_disk_type          = "pd-standard"
boot_disk_type          = "pd-standard"
subnet_cidr             = "10.0.1.0/24"
ssh_source_ranges       = ["0.0.0.0/0"]
grafana_source_ranges   = ["0.0.0.0/0"]
use_static_ip           = true
ssh_public_key          = "ssh-rsa AAAA test@marketplace"
grafana_password        = "TestPassword123!"

