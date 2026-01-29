# frozen_string_literal: true

require "json"

module PostgresAI
  #
  # PostgreSQL health check runner.
  #
  # Can be initialized with:
  # - Connection string: Checkup.new("postgresql://...")
  # - PG connection: Checkup.new(pg_conn)
  # - ActiveRecord: Checkup.from_active_record
  #
  class Checkup
    attr_reader :node_name

    def initialize(connection, node_name: "node-01")
      @connection_input = connection
      @connection = nil
      @owns_connection = false
      @node_name = node_name
      @pg_version = nil
    end

    # Create Checkup from ActiveRecord connection
    def self.from_active_record(connection = nil)
      connection ||= ActiveRecord::Base.connection
      new(connection.raw_connection)
    end

    # Create Checkup from Sequel database
    def self.from_sequel(db)
      new(db.synchronize { |conn| conn })
    end

    # ==========================================================================
    # Connection Management
    # ==========================================================================

    def connection
      return @connection if @connection

      case @connection_input
      when String
        # Connection string - create new connection
        require "pg"
        @connection = PG.connect(@connection_input)
        @owns_connection = true
      else
        # Assume it's already a PG::Connection
        @connection = @connection_input
        @owns_connection = false
      end

      @connection
    end

    def execute(sql)
      result = connection.exec(sql)
      result.map { |row| row.transform_keys(&:to_sym) }
    end

    def close
      return unless @owns_connection && @connection

      @connection.close
      @connection = nil
    end

    # ==========================================================================
    # Version & Database Info
    # ==========================================================================

    def postgres_version
      return @pg_version if @pg_version

      rows = execute(<<~SQL)
        SELECT name, setting
        FROM pg_settings
        WHERE name IN ('server_version', 'server_version_num')
      SQL

      version = ""
      version_num = 0

      rows.each do |row|
        case row[:name]
        when "server_version"
          version = row[:setting]
        when "server_version_num"
          version_num = row[:setting].to_i
        end
      end

      major = version_num / 10_000
      minor = version_num % 10_000

      @pg_version = PostgresVersion.new(
        version: version,
        server_version_num: version_num,
        major: major,
        minor: minor
      )
    end

    def current_database
      rows = execute(<<~SQL)
        SELECT
          current_database() as datname,
          pg_database_size(current_database()) as size_bytes
      SQL
      rows.first || { datname: "postgres", size_bytes: 0 }
    end

    # ==========================================================================
    # Individual Check Methods
    # ==========================================================================

    # H002: Find unused indexes
    def check_h002_unused_indexes
      postgres_version # Ensure version is cached
      db_info = current_database

      sql = <<~SQL
        WITH fk_indexes AS (
          SELECT
            n.nspname AS schema_name,
            ci.relname AS index_name,
            cr.relname AS table_name,
            (confrelid::regclass)::text AS fk_table_ref,
            array_to_string(indclass, ', ') AS opclasses
          FROM pg_index i
          JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relkind = 'i'
          JOIN pg_class cr ON cr.oid = i.indrelid AND cr.relkind = 'r'
          JOIN pg_namespace n ON n.oid = ci.relnamespace
          JOIN pg_constraint cn ON cn.conrelid = cr.oid
          LEFT JOIN pg_stat_all_indexes AS si ON si.indexrelid = i.indexrelid
          WHERE contype = 'f'
            AND i.indisunique IS false
            AND conkey IS NOT NULL
            AND ci.relpages > 5
            AND si.idx_scan < 10
        ),
        table_scans AS (
          SELECT
            relid,
            tables.idx_scan + tables.seq_scan AS all_scans,
            (tables.n_tup_ins + tables.n_tup_upd + tables.n_tup_del) AS writes,
            pg_relation_size(relid) AS table_size
          FROM pg_stat_all_tables AS tables
          JOIN pg_class c ON c.oid = relid
          WHERE c.relpages > 5
        ),
        indexes AS (
          SELECT
            i.indrelid,
            i.indexrelid,
            n.nspname AS schema_name,
            cr.relname AS table_name,
            ci.relname AS index_name,
            si.idx_scan,
            pg_relation_size(i.indexrelid) AS index_bytes,
            ci.relpages,
            (CASE WHEN a.amname = 'btree' THEN true ELSE false END) AS idx_is_btree,
            array_to_string(i.indclass, ', ') AS opclasses
          FROM pg_index i
          JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relkind = 'i'
          JOIN pg_class cr ON cr.oid = i.indrelid AND cr.relkind = 'r'
          JOIN pg_namespace n ON n.oid = ci.relnamespace
          JOIN pg_am a ON ci.relam = a.oid
          LEFT JOIN pg_stat_all_indexes AS si ON si.indexrelid = i.indexrelid
          WHERE i.indisunique = false
            AND i.indisvalid = true
            AND ci.relpages > 5
        ),
        index_ratios AS (
          SELECT
            i.indexrelid AS index_id,
            i.schema_name,
            i.table_name,
            i.index_name,
            idx_scan,
            all_scans,
            ROUND((CASE WHEN all_scans = 0 THEN 0.0::numeric
                ELSE idx_scan::numeric/all_scans * 100 END), 2) AS index_scan_pct,
            writes,
            ROUND((CASE WHEN writes = 0 THEN idx_scan::numeric
                ELSE idx_scan::numeric/writes END), 2) AS scans_per_write,
            index_bytes AS index_size_bytes,
            table_size AS table_size_bytes,
            i.relpages,
            idx_is_btree,
            i.opclasses,
            (
              SELECT count(1)
              FROM fk_indexes fi
              WHERE fi.fk_table_ref = i.table_name
                AND fi.schema_name = i.schema_name
                AND fi.opclasses LIKE (i.opclasses || '%')
            ) > 0 AS supports_fk
          FROM indexes i
          JOIN table_scans ts ON ts.relid = i.indrelid
        )
        SELECT
          'Never Used Indexes' AS reason,
          schema_name,
          table_name,
          index_name,
          pg_get_indexdef(index_id) AS index_definition,
          idx_scan,
          index_size_bytes,
          idx_is_btree,
          supports_fk
        FROM index_ratios
        WHERE idx_scan = 0
        ORDER BY index_size_bytes DESC
      SQL

      rows = execute(sql)

      # Get stats reset info
      stats_reset = execute(<<~SQL).first || {}
        SELECT
          EXTRACT(EPOCH FROM stats_reset) AS stats_reset_epoch,
          stats_reset::text AS stats_reset_time,
          EXTRACT(EPOCH FROM (now() - stats_reset)) / 86400 AS days_since_reset
        FROM pg_stat_database
        WHERE datname = current_database()
      SQL

      unused_indexes = []
      total_size = 0

      rows.each do |row|
        size_bytes = row[:index_size_bytes].to_i
        total_size += size_bytes

        unused_indexes << {
          schema_name: row[:schema_name],
          table_name: row[:table_name],
          index_name: row[:index_name],
          index_definition: row[:index_definition] || "",
          reason: row[:reason] || "Never Used Indexes",
          idx_scan: row[:idx_scan].to_i,
          index_size_bytes: size_bytes,
          idx_is_btree: row[:idx_is_btree] == "t" || row[:idx_is_btree] == true,
          supports_fk: row[:supports_fk] == "t" || row[:supports_fk] == true,
          index_size_pretty: PostgresAI.format_bytes(size_bytes)
        }
      end

      db_size = db_info[:size_bytes].to_i
      db_name = db_info[:datname]

      data = {
        db_name => {
          unused_indexes: unused_indexes,
          total_count: unused_indexes.length,
          total_size_bytes: total_size,
          total_size_pretty: PostgresAI.format_bytes(total_size),
          database_size_bytes: db_size,
          database_size_pretty: PostgresAI.format_bytes(db_size),
          stats_reset: {
            stats_reset_epoch: stats_reset[:stats_reset_epoch]&.to_f,
            stats_reset_time: stats_reset[:stats_reset_time],
            days_since_reset: stats_reset[:days_since_reset]&.to_i,
            postmaster_startup_epoch: nil,
            postmaster_startup_time: nil
          }
        }
      }

      create_result("H002", "Unused indexes", data)
    end

    # H001: Find invalid indexes
    def check_h001_invalid_indexes
      postgres_version
      db_info = current_database

      sql = <<~SQL
        WITH invalid AS (
          SELECT
            n.nspname AS schema_name,
            ct.relname AS table_name,
            ci.relname AS index_name,
            n.nspname || '.' || ci.relname AS relation_name,
            pg_relation_size(i.indexrelid) AS index_size_bytes,
            pg_get_indexdef(i.indexrelid) AS index_definition,
            i.indisprimary AS is_pk,
            i.indisunique AS is_unique,
            con.conname AS constraint_name,
            ct.reltuples::bigint AS table_row_estimate,
            EXISTS (
              SELECT 1 FROM pg_index i2
              JOIN pg_class ci2 ON ci2.oid = i2.indexrelid
              WHERE i2.indrelid = i.indrelid
                AND i2.indisvalid = true
                AND pg_get_indexdef(i2.indexrelid) = pg_get_indexdef(i.indexrelid)
            ) AS has_valid_duplicate
          FROM pg_index i
          JOIN pg_class ci ON ci.oid = i.indexrelid
          JOIN pg_class ct ON ct.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = ci.relnamespace
          LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
          WHERE i.indisvalid = false
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        )
        SELECT * FROM invalid ORDER BY index_size_bytes DESC
      SQL

      rows = execute(sql)

      invalid_indexes = []
      total_size = 0

      rows.each do |row|
        size_bytes = row[:index_size_bytes].to_i
        total_size += size_bytes

        invalid_indexes << {
          schema_name: row[:schema_name],
          table_name: row[:table_name],
          index_name: row[:index_name],
          relation_name: row[:relation_name] || "",
          index_size_bytes: size_bytes,
          index_size_pretty: PostgresAI.format_bytes(size_bytes),
          index_definition: row[:index_definition] || "",
          supports_fk: false,
          is_pk: row[:is_pk] == "t" || row[:is_pk] == true,
          is_unique: row[:is_unique] == "t" || row[:is_unique] == true,
          constraint_name: row[:constraint_name],
          table_row_estimate: row[:table_row_estimate].to_i,
          has_valid_duplicate: row[:has_valid_duplicate] == "t" || row[:has_valid_duplicate] == true,
          valid_duplicate_name: nil,
          valid_duplicate_definition: nil
        }
      end

      db_size = db_info[:size_bytes].to_i
      db_name = db_info[:datname]

      data = {
        db_name => {
          invalid_indexes: invalid_indexes,
          total_count: invalid_indexes.length,
          total_size_bytes: total_size,
          total_size_pretty: PostgresAI.format_bytes(total_size),
          database_size_bytes: db_size,
          database_size_pretty: PostgresAI.format_bytes(db_size)
        }
      }

      create_result("H001", "Invalid indexes", data)
    end

    # H004: Find redundant indexes
    def check_h004_redundant_indexes
      postgres_version
      db_info = current_database

      sql = <<~SQL
        WITH index_data AS (
          SELECT
            n.nspname AS schema_name,
            ct.relname AS table_name,
            ci.relname AS index_name,
            n.nspname || '.' || ci.relname AS relation_name,
            am.amname AS access_method,
            pg_get_indexdef(i.indexrelid) AS index_definition,
            pg_relation_size(i.indexrelid) AS index_size_bytes,
            pg_relation_size(i.indrelid) AS table_size_bytes,
            COALESCE(s.idx_scan, 0) AS index_usage,
            i.indkey::text AS indkey_text,
            i.indrelid,
            i.indexrelid
          FROM pg_index i
          JOIN pg_class ci ON ci.oid = i.indexrelid
          JOIN pg_class ct ON ct.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = ci.relnamespace
          JOIN pg_am am ON am.oid = ci.relam
          LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
          WHERE i.indisvalid = true
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ),
        redundant AS (
          SELECT
            d1.*,
            d2.index_name AS redundant_to_name,
            d2.index_definition AS redundant_to_definition,
            d2.index_size_bytes AS redundant_to_size_bytes
          FROM index_data d1
          JOIN index_data d2 ON d1.indrelid = d2.indrelid
            AND d1.indexrelid != d2.indexrelid
            AND d1.indkey_text LIKE d2.indkey_text || '%'
            AND d1.indkey_text != d2.indkey_text
          WHERE d1.access_method = d2.access_method
        )
        SELECT DISTINCT ON (schema_name, table_name, index_name)
          schema_name,
          table_name,
          index_name,
          relation_name,
          access_method,
          'Redundant to: ' || redundant_to_name AS reason,
          index_size_bytes,
          table_size_bytes,
          index_usage,
          false AS supports_fk,
          index_definition,
          json_agg(json_build_object(
            'index_name', redundant_to_name,
            'index_definition', redundant_to_definition,
            'index_size_bytes', redundant_to_size_bytes
          )) AS redundant_to_json
        FROM redundant
        GROUP BY schema_name, table_name, index_name, relation_name,
                 access_method, index_size_bytes, table_size_bytes,
                 index_usage, index_definition, redundant_to_name
        ORDER BY schema_name, table_name, index_name, index_size_bytes DESC
      SQL

      rows = execute(sql)

      redundant_indexes = []
      total_size = 0

      rows.each do |row|
        size_bytes = row[:index_size_bytes].to_i
        table_size = row[:table_size_bytes].to_i
        total_size += size_bytes

        # Parse redundant_to JSON
        redundant_to = []
        if row[:redundant_to_json]
          begin
            rt_data = JSON.parse(row[:redundant_to_json])
            rt_data.each do |item|
              rt_size = item["index_size_bytes"].to_i
              redundant_to << {
                index_name: item["index_name"],
                index_definition: item["index_definition"],
                index_size_bytes: rt_size,
                index_size_pretty: PostgresAI.format_bytes(rt_size)
              }
            end
          rescue JSON::ParserError
            # Ignore parse errors
          end
        end

        redundant_indexes << {
          schema_name: row[:schema_name],
          table_name: row[:table_name],
          index_name: row[:index_name],
          relation_name: row[:relation_name] || "",
          access_method: row[:access_method] || "btree",
          reason: row[:reason] || "",
          index_size_bytes: size_bytes,
          table_size_bytes: table_size,
          index_usage: row[:index_usage].to_i,
          supports_fk: row[:supports_fk] == "t" || row[:supports_fk] == true,
          index_definition: row[:index_definition] || "",
          index_size_pretty: PostgresAI.format_bytes(size_bytes),
          table_size_pretty: PostgresAI.format_bytes(table_size),
          redundant_to: redundant_to
        }
      end

      db_size = db_info[:size_bytes].to_i
      db_name = db_info[:datname]

      data = {
        db_name => {
          redundant_indexes: redundant_indexes,
          total_count: redundant_indexes.length,
          total_size_bytes: total_size,
          total_size_pretty: PostgresAI.format_bytes(total_size),
          database_size_bytes: db_size,
          database_size_pretty: PostgresAI.format_bytes(db_size)
        }
      }

      create_result("H004", "Redundant indexes", data)
    end

    # A002: Get PostgreSQL version
    def check_a002_version
      pg_ver = postgres_version

      data = {
        version: pg_ver.to_h
      }

      create_result("A002", "Postgres major version", data)
    end

    # F004: Estimate table bloat
    def check_f004_table_bloat
      postgres_version
      db_info = current_database

      sql = <<~SQL
        SELECT
          schemaname AS schema_name,
          relname AS table_name,
          pg_relation_size(relid) AS real_size,
          COALESCE(n_dead_tup, 0) AS dead_tuples,
          COALESCE(n_live_tup, 0) AS live_tuples,
          CASE WHEN n_live_tup > 0
            THEN ROUND(100.0 * n_dead_tup / n_live_tup, 2)
            ELSE 0
          END AS bloat_pct,
          last_vacuum,
          last_autovacuum
        FROM pg_stat_user_tables
        WHERE pg_relation_size(relid) > 1024 * 1024
        ORDER BY n_dead_tup DESC
        LIMIT 100
      SQL

      rows = execute(sql)

      bloated_tables = []
      total_bloat = 0

      rows.each do |row|
        real_size = row[:real_size].to_i
        bloat_pct = row[:bloat_pct].to_f
        estimated_bloat = (real_size * bloat_pct / 100).to_i
        total_bloat += estimated_bloat

        last_vacuum = row[:last_vacuum] || row[:last_autovacuum]

        bloated_tables << {
          schema_name: row[:schema_name],
          table_name: row[:table_name],
          real_size: real_size,
          real_size_pretty: PostgresAI.format_bytes(real_size),
          bloat_pct: bloat_pct,
          bloat_size: estimated_bloat,
          bloat_size_pretty: PostgresAI.format_bytes(estimated_bloat),
          dead_tuples: row[:dead_tuples].to_i,
          live_tuples: row[:live_tuples].to_i,
          last_vacuum: last_vacuum&.to_s,
          fillfactor: 100
        }
      end

      db_size = db_info[:size_bytes].to_i
      db_name = db_info[:datname]

      data = {
        db_name => {
          bloated_tables: bloated_tables,
          total_count: bloated_tables.length,
          total_bloat_size_bytes: total_bloat,
          total_bloat_size_pretty: PostgresAI.format_bytes(total_bloat),
          database_size_bytes: db_size,
          database_size_pretty: PostgresAI.format_bytes(db_size)
        }
      }

      create_result("F004", "Autovacuum: heap bloat (estimated)", data)
    end

    # ==========================================================================
    # Run Checks
    # ==========================================================================

    # Run all available checks
    def run_all(&on_progress)
      results = {}
      total = AVAILABLE_CHECKS.length

      AVAILABLE_CHECKS.each_with_index do |(check_id, check_info), index|
        on_progress&.call(check_id, check_info[:title], index + 1, total)

        method_name = check_info[:method]
        results[check_id] = if respond_to?(method_name)
                              begin
                                send(method_name)
                              rescue StandardError => e
                                create_result(check_id, check_info[:title], {}, error: e.message)
                              end
                            else
                              create_result(check_id, check_info[:title], {},
                                            error: "Method not implemented: #{method_name}")
                            end
      end

      results
    end

    # Run a specific check
    def run_check(check_id)
      check_info = AVAILABLE_CHECKS[check_id]
      raise ArgumentError, "Unknown check ID: #{check_id}" unless check_info

      method_name = check_info[:method]
      raise ArgumentError, "Method not implemented: #{method_name}" unless respond_to?(method_name)

      send(method_name)
    end

    private

    def create_result(check_id, check_title, data, error: nil)
      CheckResult.new(
        check_id: check_id,
        check_title: check_title,
        data: data,
        postgres_version: @pg_version,
        error: error
      )
    end
  end
end
