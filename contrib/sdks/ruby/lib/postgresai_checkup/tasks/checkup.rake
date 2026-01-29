# frozen_string_literal: true

#
# PostgresAI Express Checkup - Rails Rake Tasks
#
# Usage:
#   rails postgresai:checkup              # Run all checks
#   rails postgresai:checkup[H002]        # Run specific check
#   rails postgresai:checkup:list         # List available checks
#   rails postgresai:checkup:json         # Output as JSON
#

namespace :postgresai do
  desc "Run PostgresAI health checks"
  task :checkup, [:check_id] => :environment do |_t, args|
    require "postgresai_checkup"

    check_id = args[:check_id]

    puts "Running PostgresAI health checks..."
    puts

    checkup = PostgresAI::Checkup.from_active_record

    results = if check_id
                { check_id => checkup.run_check(check_id) }
              else
                checkup.run_all do |cid, title, index, total|
                  puts "  [#{index}/#{total}] #{cid}: #{title}"
                end
              end

    puts
    puts "=" * 60
    puts "Results"
    puts "=" * 60

    results.each do |cid, result|
      puts
      puts "#{cid}: #{result.check_title}"
      puts "-" * 40

      if result.error
        puts "  ERROR: #{result.error}"
      else
        print_summary(cid, result)
      end
    end
  end

  namespace :checkup do
    desc "List available checks"
    task :list do
      require "postgresai_checkup"

      puts "Available PostgresAI health checks:"
      puts
      PostgresAI::AVAILABLE_CHECKS.each do |check_id, info|
        puts "  #{check_id}: #{info[:title]}"
        puts "    #{info[:description]}"
        puts
      end
    end

    desc "Run checks and output JSON"
    task :json, [:check_id] => :environment do |_t, args|
      require "postgresai_checkup"
      require "json"

      check_id = args[:check_id]
      checkup = PostgresAI::Checkup.from_active_record

      results = if check_id
                  { check_id => checkup.run_check(check_id) }
                else
                  checkup.run_all
                end

      output = results.transform_values(&:to_h)
      puts JSON.pretty_generate(output)
    end
  end

  def print_summary(check_id, result)
    data = result.data

    case check_id
    when "H001", "H002", "H004"
      data.each do |db_name, db_data|
        count = db_data[:total_count] || 0
        size = db_data[:total_size_pretty] || "0 B"
        puts "  Database: #{db_name}"
        puts "  Found: #{count} items (#{size})"
      end
    when "F004"
      data.each do |db_name, db_data|
        count = db_data[:total_count] || 0
        bloat = db_data[:total_bloat_size_pretty] || "0 B"
        puts "  Database: #{db_name}"
        puts "  Tables analyzed: #{count}"
        puts "  Estimated bloat: #{bloat}"
      end
    when "A002"
      version_info = data[:version] || {}
      puts "  Version: #{version_info[:version] || 'unknown'}"
    end
  end
end
