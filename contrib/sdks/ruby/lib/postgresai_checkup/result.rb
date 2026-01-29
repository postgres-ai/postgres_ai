# frozen_string_literal: true

require "json"
require "time"

module PostgresAI
  # PostgreSQL version information
  class PostgresVersion
    attr_reader :version, :server_version_num, :major, :minor

    def initialize(version:, server_version_num:, major:, minor:)
      @version = version
      @server_version_num = server_version_num
      @major = major
      @minor = minor
    end

    def to_h
      {
        version: @version,
        server_version_num: @server_version_num.to_s,
        server_major_ver: @major.to_s,
        server_minor_ver: @minor.to_s
      }
    end
  end

  # Result of a single health check
  class CheckResult
    attr_reader :check_id, :check_title, :timestamp, :data, :postgres_version, :error

    def initialize(check_id:, check_title:, data:, timestamp: nil, postgres_version: nil, error: nil)
      @check_id = check_id
      @check_title = check_title
      @timestamp = timestamp || Time.now.utc.iso8601
      @data = data
      @postgres_version = postgres_version
      @error = error
    end

    # Convert to hash matching JSON schema
    def to_h
      result_data = { data: @data }
      result_data[:postgres_version] = @postgres_version.to_h if @postgres_version
      result_data[:error] = @error if @error

      {
        checkId: @check_id,
        checkTitle: @check_title,
        timestamptz: @timestamp,
        generation_mode: "express",
        nodes: { primary: "node-01", standbys: [] },
        results: { "node-01" => result_data }
      }
    end

    # Convert to JSON string
    def to_json(pretty: true)
      if pretty
        JSON.pretty_generate(to_h)
      else
        to_h.to_json
      end
    end

    def success?
      @error.nil?
    end

    def failed?
      !success?
    end
  end
end
