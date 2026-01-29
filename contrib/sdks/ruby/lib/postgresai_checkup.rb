# frozen_string_literal: true

#
# PostgresAI Express Checkup - Ruby SDK
#
# A lightweight library for running PostgreSQL health checks directly from Ruby.
# Works standalone or integrates with Rails/ActiveRecord.
#
# Usage:
#   require 'postgresai_checkup'
#
#   # Standalone with connection string
#   checkup = PostgresAI::Checkup.new("postgresql://user:pass@localhost:5432/mydb")
#   reports = checkup.run_all
#
#   # With ActiveRecord
#   checkup = PostgresAI::Checkup.from_active_record
#   reports = checkup.run_all
#
#   # Single check
#   result = checkup.run_check("H002")
#

require_relative "postgresai_checkup/version"
require_relative "postgresai_checkup/checkup"
require_relative "postgresai_checkup/checks"
require_relative "postgresai_checkup/result"

module PostgresAI
  class Error < StandardError; end

  # Format bytes to human-readable string (IEC binary units)
  def self.format_bytes(size_bytes)
    return "0 B" if size_bytes.zero?

    units = %w[B KiB MiB GiB TiB PiB]
    i = 0
    size = size_bytes.to_f

    while size >= 1024 && i < units.length - 1
      size /= 1024
      i += 1
    end

    format("%.2f %s", size, units[i])
  end
end
