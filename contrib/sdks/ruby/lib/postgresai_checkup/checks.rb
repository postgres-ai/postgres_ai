# frozen_string_literal: true

module PostgresAI
  # Available health checks and their metadata
  AVAILABLE_CHECKS = {
    "A002" => {
      title: "Postgres major version",
      method: :check_a002_version,
      description: "Get PostgreSQL major version information"
    },
    "H001" => {
      title: "Invalid indexes",
      method: :check_h001_invalid_indexes,
      description: "Find invalid indexes (indisvalid = false)"
    },
    "H002" => {
      title: "Unused indexes",
      method: :check_h002_unused_indexes,
      description: "Find indexes that have never been scanned"
    },
    "H004" => {
      title: "Redundant indexes",
      method: :check_h004_redundant_indexes,
      description: "Find indexes covered by other indexes"
    },
    "F004" => {
      title: "Autovacuum: heap bloat (estimated)",
      method: :check_f004_table_bloat,
      description: "Estimate table bloat from dead tuples"
    }
  }.freeze
end
