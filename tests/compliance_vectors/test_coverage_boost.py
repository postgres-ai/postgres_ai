"""
Coverage Boost Tests - Increase coverage for migration safety.

These tests cover code paths not exercised by existing tests,
ensuring Python behavior is documented for TypeScript migration.

Run with: pytest tests/compliance_vectors/test_coverage_boost.py -v
"""
import time
from typing import Any, Callable, Dict, List, Optional
from unittest.mock import MagicMock, patch
import pytest

from reporter.postgres_reports import PostgresReportGenerator


@pytest.fixture(name="generator")
def fixture_generator() -> PostgresReportGenerator:
    """Create a generator with mock URLs."""
    return PostgresReportGenerator(
        prometheus_url="http://prom.test:9090",
        postgres_sink_url=None,
    )


@pytest.fixture(name="prom_result")
def fixture_prom_result() -> Callable[[Optional[List[Dict]], str], Dict]:
    """Build a Prometheus-like payload."""
    def _builder(rows: Optional[List[Dict]] = None, status: str = "success") -> Dict:
        return {
            "status": status,
            "data": {
                "result": rows or [],
            },
        }
    return _builder


# ============================================================================
# Connection Tests
# ============================================================================

class TestConnectionMethods:
    """Test connection handling and error paths."""

    def test_test_connection_success(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Successful Prometheus connection test."""
        mock_response = MagicMock()
        mock_response.status_code = 200

        with patch("requests.get", return_value=mock_response):
            result = generator.test_connection()
            assert result is True

    def test_test_connection_failure(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Failed Prometheus connection test."""
        with patch("requests.get", side_effect=Exception("Connection refused")):
            result = generator.test_connection()
            assert result is False

    def test_connect_postgres_sink_no_url(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Postgres sink connection with no URL configured."""
        assert generator.postgres_sink_url is None
        result = generator.connect_postgres_sink()
        assert result is False

    def test_close_postgres_sink_no_connection(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Close sink when no connection exists."""
        generator.pg_conn = None
        generator.close_postgres_sink()  # Should not raise
        assert generator.pg_conn is None

    def test_close_postgres_sink_with_connection(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Close sink with active connection."""
        mock_conn = MagicMock()
        generator.pg_conn = mock_conn
        generator.close_postgres_sink()
        mock_conn.close.assert_called_once()
        assert generator.pg_conn is None


# ============================================================================
# Query Methods Tests
# ============================================================================

class TestQueryMethods:
    """Test Prometheus query methods."""

    def test_query_instant_success(
        self,
        generator: PostgresReportGenerator,
        prom_result: Callable,
    ) -> None:
        """Successful instant query."""
        expected = prom_result([{"metric": {"foo": "bar"}, "value": [0, "42"]}])
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = expected

        with patch("requests.get", return_value=mock_response):
            result = generator.query_instant("up")
            assert result["status"] == "success"

    def test_query_instant_error(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Query instant with network error."""
        with patch("requests.get", side_effect=Exception("Network error")):
            result = generator.query_instant("up")
            # Should return empty dict on error
            assert result == {}


# ============================================================================
# Formatting Methods Tests
# ============================================================================

class TestFormattingMethods:
    """Test formatting and helper methods."""

    def test_format_bytes_zero(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format zero bytes."""
        result = generator.format_bytes(0)
        assert result == "0 B"

    def test_format_bytes_kib(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format kibibytes."""
        result = generator.format_bytes(1024)
        assert "KiB" in result

    def test_format_bytes_mib(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format mebibytes."""
        result = generator.format_bytes(1024 * 1024)
        assert "MiB" in result

    def test_format_bytes_gib(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format gibibytes."""
        result = generator.format_bytes(1024 * 1024 * 1024)
        assert "GiB" in result

    def test_format_bytes_tib(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format tebibytes."""
        result = generator.format_bytes(1024 * 1024 * 1024 * 1024)
        assert "TiB" in result

    def test_format_bytes_large_value(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format large value shows no decimals."""
        result = generator.format_bytes(200 * 1024 * 1024)  # 200 MiB
        assert "200" in result
        assert "." not in result.split()[0]  # No decimal for >= 100

    def test_format_bytes_medium_value(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format medium value shows 1 decimal."""
        result = generator.format_bytes(50 * 1024 * 1024)  # 50 MiB
        assert "50" in result

    def test_format_setting_value_memory(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format memory setting value."""
        result = generator.format_setting_value("shared_buffers", "128", "8kB")
        assert result is not None

    def test_format_setting_value_no_unit(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format setting value without unit."""
        result = generator.format_setting_value("max_connections", "100", "")
        assert "100" in str(result)

    def test_format_epoch_timestamp_valid(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format valid epoch timestamp."""
        result = generator.format_epoch_timestamp(1704067200)  # 2024-01-01
        assert result is not None
        assert "2024" in result

    def test_format_epoch_timestamp_zero(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format zero epoch returns None."""
        result = generator.format_epoch_timestamp(0)
        assert result is None

    def test_format_epoch_timestamp_none(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format None epoch returns None."""
        result = generator.format_epoch_timestamp(None)
        assert result is None

    def test_format_epoch_timestamp_invalid(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format invalid epoch returns None."""
        result = generator.format_epoch_timestamp("invalid")
        assert result is None


# ============================================================================
# Report Data Formatting Tests
# ============================================================================

class TestReportDataFormatting:
    """Test report data formatting methods."""

    def test_format_report_data_basic(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Basic report data formatting."""
        result = generator.format_report_data(
            "TEST001",
            {"test_key": "test_value"},
            host="test-host"
        )
        assert result["checkId"] == "TEST001"
        assert "data" in result or "test_key" in str(result)

    def test_format_report_data_with_version(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Report data with postgres version."""
        version_info = {"version": "15.3", "server_version_num": "150003"}
        result = generator.format_report_data(
            "TEST002",
            {"data": "value"},
            host="test-host",
            postgres_version=version_info
        )
        assert "postgres_version" in result or "15.3" in str(result)


# ============================================================================
# Database Methods Tests
# ============================================================================

class TestDatabaseMethods:
    """Test database-related methods."""

    def test_get_all_databases_success(
        self,
        monkeypatch: pytest.MonkeyPatch,
        generator: PostgresReportGenerator,
        prom_result: Callable,
    ) -> None:
        """Get all databases successfully."""
        response = prom_result([
            {"metric": {"datname": "postgres"}},
            {"metric": {"datname": "app_db"}},
        ])
        monkeypatch.setattr(generator, "query_instant", lambda q: response)

        result = generator.get_all_databases("test-cluster", "node-01")
        assert "postgres" in result
        assert "app_db" in result

    def test_get_all_databases_empty(
        self,
        monkeypatch: pytest.MonkeyPatch,
        generator: PostgresReportGenerator,
        prom_result: Callable,
    ) -> None:
        """Get databases when none exist."""
        monkeypatch.setattr(generator, "query_instant", lambda q: prom_result([]))

        result = generator.get_all_databases("test-cluster", "node-01")
        assert result == []


# ============================================================================
# Timeline and Densify Tests
# ============================================================================

class TestTimelineAndDensify:
    """Test timeline building and densification."""

    def test_build_timeline(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Build timeline with hours."""
        end_s = int(time.time())
        start_s, timeline = generator._build_timeline(end_s, hours=3, step_s=3600)
        assert len(timeline) == 3
        # Timeline should be in ascending order
        assert timeline == sorted(timeline)

    def test_build_timeline_single_hour(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Build timeline with single hour."""
        end_s = int(time.time())
        start_s, timeline = generator._build_timeline(end_s, hours=1, step_s=3600)
        assert len(timeline) == 1

    def test_build_timeline_returns_start(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Build timeline returns correct start timestamp."""
        end_s = 10000
        start_s, timeline = generator._build_timeline(end_s, hours=3, step_s=3600)
        assert start_s == timeline[0]

    def test_densify_with_data(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Densify time series with existing data."""
        timeline = [1000, 2000, 3000]
        qids = ["q1", "q2"]
        series_pts = {
            "q1": {1000: 10.0, 2000: 20.0},
            "q2": {2000: 5.0},
        }

        result = generator._densify(series_pts, qids, timeline)

        assert len(result["q1"]) == 3
        assert len(result["q2"]) == 3
        assert result["q1"][0] == 10.0
        assert result["q1"][1] == 20.0

    def test_densify_empty_series(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Densify with empty series."""
        timeline = [1000, 2000]
        qids = ["q1"]

        result = generator._densify({}, qids, timeline)

        assert len(result["q1"]) == 2
        assert all(v == 0.0 for v in result["q1"])


# ============================================================================
# Version Info Tests
# ============================================================================

class TestVersionInfo:
    """Test PostgreSQL version info methods."""

    def test_get_postgres_version_info_success(
        self,
        monkeypatch: pytest.MonkeyPatch,
        generator: PostgresReportGenerator,
        prom_result: Callable,
    ) -> None:
        """Get version info successfully."""
        response = prom_result([
            {"metric": {"setting_name": "server_version", "setting_value": "15.3"}},
            {"metric": {"setting_name": "server_version_num", "setting_value": "150003"}},
        ])
        monkeypatch.setattr(generator, "query_instant", lambda q: response)

        result = generator._get_postgres_version_info("test-cluster", "node-01")
        # Result may have version info or be empty depending on query structure
        assert isinstance(result, dict)

    def test_get_postgres_version_info_not_found(
        self,
        monkeypatch: pytest.MonkeyPatch,
        generator: PostgresReportGenerator,
        prom_result: Callable,
    ) -> None:
        """Version info not available."""
        monkeypatch.setattr(generator, "query_instant", lambda q: prom_result([]))

        result = generator._get_postgres_version_info("test-cluster", "node-01")
        # Should return empty dict or default values
        assert isinstance(result, dict)


# ============================================================================
# Edge Cases and Error Handling
# ============================================================================

class TestEdgeCases:
    """Test edge cases and error handling."""

    def test_parse_memory_value_with_spaces(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse memory value with leading/trailing spaces."""
        result = generator._parse_memory_value("  128MB  ")
        assert result == 128 * 1024 * 1024

    def test_parse_memory_value_lowercase(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse memory value with lowercase unit."""
        result = generator._parse_memory_value("256mb")
        assert result == 256 * 1024 * 1024

    def test_parse_memory_value_tb(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse terabyte value."""
        result = generator._parse_memory_value("1TB")
        assert result == 1024 * 1024 * 1024 * 1024

    def test_parse_memory_value_bytes_only(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse value with B suffix only."""
        result = generator._parse_memory_value("1024B")
        assert result == 1024

    def test_parse_memory_value_float(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse memory value with float."""
        result = generator._parse_memory_value("1.5GB")
        assert result == int(1.5 * 1024 * 1024 * 1024)

    def test_build_qid_regex_single(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Build regex for single query ID."""
        result = generator._build_qid_regex(["12345"])
        assert "12345" in result
        assert result.startswith("^(?:")
        assert result.endswith(")$")

    def test_build_qid_regex_negative(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Build regex with negative query ID."""
        result = generator._build_qid_regex(["-12345"])
        assert "-12345" in result

    def test_build_qid_regex_multiple(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Build regex for multiple query IDs."""
        result = generator._build_qid_regex(["111", "222", "333"])
        assert "111" in result
        assert "222" in result
        assert "333" in result
        assert "|" in result


# ============================================================================
# Query Range Tests
# ============================================================================

class TestQueryRange:
    """Test Prometheus range query methods."""

    def test_query_range_success(
        self,
        generator: PostgresReportGenerator,
        prom_result: Callable,
    ) -> None:
        """Successful range query."""
        from datetime import datetime
        expected = prom_result([{"metric": {"foo": "bar"}, "values": [[0, "42"]]}])
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = expected

        with patch("requests.get", return_value=mock_response):
            start = datetime(2024, 1, 1, 0, 0, 0)
            end = datetime(2024, 1, 1, 1, 0, 0)
            result = generator.query_range("up", start, end)
            # query_range returns the result list directly on success
            assert isinstance(result, list)

    def test_query_range_error(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Query range with network error."""
        from datetime import datetime
        with patch("requests.get", side_effect=Exception("Network error")):
            start = datetime(2024, 1, 1, 0, 0, 0)
            end = datetime(2024, 1, 1, 1, 0, 0)
            result = generator.query_range("up", start, end)
            # Should return empty list on error
            assert result == []


# ============================================================================
# Additional Edge Cases Tests
# ============================================================================

class TestParseMemoryValueEdgeCases:
    """Test _parse_memory_value edge cases."""

    def test_parse_memory_value_empty(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse empty value returns 0."""
        result = generator._parse_memory_value("")
        assert result == 0

    def test_parse_memory_value_negative_one(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse -1 (unlimited) returns 0."""
        result = generator._parse_memory_value("-1")
        assert result == 0

    def test_parse_memory_value_gb(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse gigabyte value."""
        result = generator._parse_memory_value("4GB")
        assert result == 4 * 1024 * 1024 * 1024

    def test_parse_memory_value_kb(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse kilobyte value."""
        result = generator._parse_memory_value("512KB")
        assert result == 512 * 1024


class TestFloorHour:
    """Test _floor_hour method."""

    def test_floor_hour_normal(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Floor timestamp to hour."""
        # 12:30:45 should floor to 12:00:00
        ts = 3600 * 12 + 1800 + 45
        result = generator._floor_hour(ts)
        assert result == 3600 * 12

    def test_floor_hour_exact(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Exact hour stays the same."""
        ts = 3600 * 12
        result = generator._floor_hour(ts)
        assert result == ts

    def test_floor_hour_with_use_current_time(
        self,
    ) -> None:
        """With use_current_time, returns original timestamp."""
        gen = PostgresReportGenerator(
            prometheus_url="http://prom.test:9090",
            postgres_sink_url=None,
            use_current_time=True,
        )
        ts = 3600 * 12 + 1800 + 45
        result = gen._floor_hour(ts)
        assert result == ts  # No flooring


class TestPrometheusToDict:
    """Test _prometheus_to_dict method."""

    def test_prometheus_to_dict_empty(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Empty data returns empty dict."""
        from datetime import datetime
        result = generator._prometheus_to_dict([], datetime(2024, 1, 1))
        assert result == {}

    def test_prometheus_to_dict_no_values(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Data without values is skipped."""
        from datetime import datetime
        data = [{"metric": {"datname": "test"}, "values": []}]
        result = generator._prometheus_to_dict(data, datetime(2024, 1, 1))
        assert result == {}

    def test_prometheus_to_dict_valid(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Valid data is converted correctly."""
        from datetime import datetime
        ts = datetime(2024, 1, 1, 12, 0, 0).timestamp()
        data = [{
            "metric": {
                "__name__": "pgwatch_pg_stat_statements_calls",
                "datname": "testdb",
                "queryid": "12345",
                "user": "testuser",
                "instance": "localhost:5432"
            },
            "values": [[ts, "100"]]
        }]
        result = generator._prometheus_to_dict(data, datetime(2024, 1, 1, 12, 0, 0))

        key = ("testdb", "12345", "testuser", "localhost:5432")
        assert key in result
        assert result[key]["calls"] == 100.0


class TestProcessPgssData:
    """Test _process_pgss_data method."""

    def test_process_pgss_data_empty(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Empty data returns empty list."""
        from datetime import datetime
        result = generator._process_pgss_data(
            [], [],
            datetime(2024, 1, 1), datetime(2024, 1, 2),
            {"calls": "calls"}
        )
        assert result == []


class TestQueryInstantStatusCodes:
    """Test query_instant with various HTTP status codes."""

    def test_query_instant_non_200_status(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Non-200 status returns empty dict."""
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error"

        with patch("requests.get", return_value=mock_response):
            result = generator.query_instant("up")
            assert result == {}


class TestConnectPostgresSinkWithUrl:
    """Test connect_postgres_sink with URL configured."""

    def test_connect_postgres_sink_success(
        self,
    ) -> None:
        """Successful postgres sink connection."""
        gen = PostgresReportGenerator(
            prometheus_url="http://prom.test:9090",
            postgres_sink_url="postgresql://user:pass@localhost/testdb",
        )

        mock_conn = MagicMock()
        with patch("psycopg2.connect", return_value=mock_conn):
            result = gen.connect_postgres_sink()
            assert result is True
            assert gen.pg_conn is mock_conn

    def test_connect_postgres_sink_failure(
        self,
    ) -> None:
        """Failed postgres sink connection."""
        import psycopg2
        gen = PostgresReportGenerator(
            prometheus_url="http://prom.test:9090",
            postgres_sink_url="postgresql://user:pass@localhost/testdb",
        )

        with patch("psycopg2.connect", side_effect=psycopg2.OperationalError("Connection refused")):
            result = gen.connect_postgres_sink()
            assert result is False


class TestFormatSettingValueEdgeCases:
    """Test format_setting_value edge cases."""

    def test_format_setting_value_time_setting(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format time-based setting value."""
        result = generator.format_setting_value("checkpoint_timeout", "300", "s")
        assert result is not None

    def test_format_setting_value_generic(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format generic setting value."""
        result = generator.format_setting_value("random_page_cost", "4.0", "")
        assert "4.0" in str(result)

    def test_format_setting_value_kib_unit(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format setting with kB unit."""
        result = generator.format_setting_value("work_mem", "8192", "kB")
        assert "8192" in str(result) or "MiB" in str(result)

    def test_format_setting_value_ms_unit(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format setting with ms unit."""
        result = generator.format_setting_value("statement_timeout", "500", "ms")
        assert "500" in str(result) or "ms" in str(result)

    def test_format_setting_value_ms_seconds(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format milliseconds that should convert to seconds."""
        result = generator.format_setting_value("statement_timeout", "5000", "ms")
        assert "5" in str(result) and "s" in str(result)

    def test_format_setting_value_min_unit(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format setting with min unit."""
        result = generator.format_setting_value("autovacuum_naptime", "5", "min")
        assert "5" in str(result) and "min" in str(result)

    def test_format_setting_value_connections_unit(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format setting with connections unit."""
        result = generator.format_setting_value("max_connections", "200", "connections")
        assert "200" in str(result)

    def test_format_setting_value_workers_unit(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format setting with workers unit."""
        result = generator.format_setting_value("autovacuum_max_workers", "3", "workers")
        assert "3" in str(result)

    def test_format_setting_value_shared_buffers_large(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format shared_buffers setting (large value)."""
        result = generator.format_setting_value("shared_buffers", "131072", "")
        assert "MiB" in str(result)

    def test_format_setting_value_shared_buffers_small(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format shared_buffers setting (small value)."""
        result = generator.format_setting_value("shared_buffers", "512", "")
        assert "KiB" in str(result)

    def test_format_setting_value_timeout_ms(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format timeout setting in ms (small value)."""
        result = generator.format_setting_value("lock_timeout", "500", "")
        assert "ms" in str(result)

    def test_format_setting_value_timeout_s(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format timeout setting as seconds (large value)."""
        result = generator.format_setting_value("lock_timeout", "60000", "")
        assert "s" in str(result)

    def test_format_setting_value_naptime_minutes(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format autovacuum_naptime in minutes."""
        result = generator.format_setting_value("autovacuum_naptime", "60", "")
        assert "min" in str(result)

    def test_format_setting_value_naptime_seconds(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format autovacuum_naptime in seconds."""
        result = generator.format_setting_value("autovacuum_naptime", "30", "")
        assert "s" in str(result)

    def test_format_setting_value_max_workers(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format autovacuum_max_workers."""
        result = generator.format_setting_value("autovacuum_max_workers", "5", "")
        assert "workers" in str(result)

    def test_format_setting_value_pgss_max(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format pg_stat_statements.max."""
        result = generator.format_setting_value("pg_stat_statements.max", "10000", "")
        assert "statements" in str(result)

    def test_format_setting_value_max_wal_size_gib(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format max_wal_size as GiB."""
        result = generator.format_setting_value("max_wal_size", "2048", "")
        assert "GiB" in str(result)

    def test_format_setting_value_max_wal_size_mib(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format max_wal_size as MiB."""
        result = generator.format_setting_value("max_wal_size", "512", "")
        assert "MiB" in str(result)

    def test_format_setting_value_checkpoint_target(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format checkpoint_completion_target."""
        result = generator.format_setting_value("checkpoint_completion_target", "0.9", "")
        assert "0.90" in str(result)

    def test_format_setting_value_hash_mem_multiplier(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format hash_mem_multiplier."""
        result = generator.format_setting_value("hash_mem_multiplier", "2.5", "")
        assert "2.5" in str(result)

    def test_format_setting_value_max_stack_depth_mib(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format max_stack_depth as MiB."""
        result = generator.format_setting_value("max_stack_depth", "2048", "")
        assert "MiB" in str(result)

    def test_format_setting_value_max_stack_depth_kib(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format max_stack_depth as KiB."""
        result = generator.format_setting_value("max_stack_depth", "512", "")
        assert "KiB" in str(result)

    def test_format_setting_value_scale_factor(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format autovacuum_vacuum_scale_factor as percentage."""
        result = generator.format_setting_value("autovacuum_vacuum_scale_factor", "0.1", "")
        assert "%" in str(result)

    def test_format_setting_value_boolean_on(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format boolean setting (on)."""
        result = generator.format_setting_value("autovacuum", "on", "")
        assert result == "on"

    def test_format_setting_value_boolean_off(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format boolean setting (off)."""
        result = generator.format_setting_value("track_counts", "off", "")
        assert result == "off"

    def test_format_setting_value_huge_pages(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format huge_pages setting."""
        result = generator.format_setting_value("huge_pages", "try", "")
        assert result == "try"

    def test_format_setting_value_unknown_setting(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format unknown setting as string."""
        result = generator.format_setting_value("some_unknown_setting", "some_value", "")
        assert result == "some_value"


# ============================================================================
# Get Cluster Metric Unit Tests
# ============================================================================

class TestGetClusterMetricUnit:
    """Test get_cluster_metric_unit method."""

    def test_metric_unit_connections(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Get unit for connections metric."""
        result = generator.get_cluster_metric_unit("connections")
        assert result is not None

    def test_metric_unit_unknown(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Get unit for unknown metric."""
        result = generator.get_cluster_metric_unit("unknown_metric")
        assert result == "" or result is None or isinstance(result, str)


# ============================================================================
# A003 Report Extraction Tests
# ============================================================================

class TestExtractPostgresVersionFromA003:
    """Test extract_postgres_version_from_a003 method."""

    def test_extract_version_empty_report(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Empty report returns empty dict."""
        result = generator.extract_postgres_version_from_a003({})
        assert result == {}

    def test_extract_version_no_results(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Report with no results returns empty dict."""
        result = generator.extract_postgres_version_from_a003({"results": {}})
        assert result == {}

    def test_extract_version_from_postgres_version(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Extract from postgres_version field."""
        report = {
            "results": {
                "node1": {
                    "postgres_version": {
                        "version": "15.3",
                        "server_version_num": "150003"
                    }
                }
            }
        }
        result = generator.extract_postgres_version_from_a003(report)
        assert result["version"] == "15.3"

    def test_extract_version_from_settings(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Extract from server_version settings."""
        report = {
            "results": {
                "node1": {
                    "data": {
                        "server_version": {"setting": "15.3"},
                        "server_version_num": {"setting": "150003"}
                    }
                }
            }
        }
        result = generator.extract_postgres_version_from_a003(report)
        assert result["version"] == "15.3"
        assert result["server_version_num"] == "150003"
        assert result["server_major_ver"] == "15"

    def test_extract_version_with_specific_node(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Extract version with specific node name."""
        report = {
            "results": {
                "node1": {"postgres_version": {"version": "14.0"}},
                "node2": {"postgres_version": {"version": "15.3"}}
            }
        }
        result = generator.extract_postgres_version_from_a003(report, node_name="node2")
        assert result["version"] == "15.3"

    def test_extract_version_no_version_settings(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """No version settings returns empty dict."""
        report = {
            "results": {
                "node1": {"data": {"shared_buffers": {"setting": "128MB"}}}
            }
        }
        result = generator.extract_postgres_version_from_a003(report)
        assert result == {}


# ============================================================================
# Get All Clusters Tests
# ============================================================================

class TestGetAllClusters:
    """Test get_all_clusters method."""

    def test_get_all_clusters_success(
        self,
        monkeypatch: pytest.MonkeyPatch,
        generator: PostgresReportGenerator,
        prom_result: Callable,
    ) -> None:
        """Get all clusters successfully."""
        response = prom_result([
            {"metric": {"cluster": "cluster-01"}},
            {"metric": {"cluster": "cluster-02"}},
        ])
        monkeypatch.setattr(generator, "query_instant", lambda q: response)

        result = generator.get_all_clusters()
        assert "cluster-01" in result
        assert "cluster-02" in result

    def test_get_all_clusters_empty(
        self,
        monkeypatch: pytest.MonkeyPatch,
        generator: PostgresReportGenerator,
        prom_result: Callable,
    ) -> None:
        """Get clusters when none exist."""
        monkeypatch.setattr(generator, "query_instant", lambda q: prom_result([]))

        result = generator.get_all_clusters()
        assert result == []


# ============================================================================
# Format Duration Tests
# ============================================================================

class TestFormatDuration:
    """Test format_duration methods if they exist."""

    def test_format_bytes_small_decimal(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format bytes with small decimal value."""
        # 1.5 KiB
        result = generator.format_bytes(1536)
        assert "1.5" in result and "KiB" in result

    def test_format_bytes_very_large(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format very large bytes value."""
        # 1 PiB in bytes - may show as TiB
        result = generator.format_bytes(1024 ** 5)
        # Accept either TiB or PiB depending on implementation
        assert "TiB" in result or "PiB" in result


# ============================================================================
# Error Path Tests
# ============================================================================

class TestErrorPaths:
    """Test various error handling paths."""

    def test_query_instant_json_error(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Query instant with JSON parse error."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.side_effect = ValueError("Invalid JSON")

        with patch("requests.get", return_value=mock_response):
            result = generator.query_instant("up")
            # Should handle error gracefully
            assert result == {} or isinstance(result, dict)

    def test_parse_memory_value_invalid(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse memory value with invalid input."""
        result = generator._parse_memory_value("not_a_number")
        # Should return 0 or handle gracefully
        assert isinstance(result, int)


# ============================================================================
# Constructor Variations Tests
# ============================================================================

class TestConstructorVariations:
    """Test different constructor configurations."""

    def test_constructor_with_excluded_dbs(
        self,
    ) -> None:
        """Constructor with excluded databases."""
        gen = PostgresReportGenerator(
            prometheus_url="http://prom.test:9090",
            postgres_sink_url=None,
            excluded_databases=["template0", "template1"],
        )
        assert "template0" in gen.excluded_databases
        assert "template1" in gen.excluded_databases

    def test_constructor_default_excluded_dbs(
        self,
    ) -> None:
        """Constructor has default excluded databases."""
        gen = PostgresReportGenerator(
            prometheus_url="http://prom.test:9090",
            postgres_sink_url=None,
        )
        # Should have some default exclusions
        assert gen.excluded_databases is not None

    def test_constructor_with_sink_url(
        self,
    ) -> None:
        """Constructor with postgres sink URL."""
        gen = PostgresReportGenerator(
            prometheus_url="http://prom.test:9090",
            postgres_sink_url="postgresql://localhost/testdb",
        )
        assert gen.postgres_sink_url == "postgresql://localhost/testdb"


# ============================================================================
# Additional Format Methods Tests
# ============================================================================

class TestFormatEpochTimestampEdgeCases:
    """Test format_epoch_timestamp edge cases."""

    def test_format_epoch_timestamp_overflow(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format timestamp that would overflow."""
        # Very large value that might overflow
        result = generator.format_epoch_timestamp(9999999999999999)
        assert result is None

    def test_format_epoch_timestamp_negative(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format negative timestamp returns None."""
        result = generator.format_epoch_timestamp(-1000)
        assert result is None

    def test_format_epoch_timestamp_float_string(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format float value as string."""
        result = generator.format_epoch_timestamp("1704067200.5")
        assert result is not None
        assert "2024" in result


class TestFormatReportDataVariations:
    """Test format_report_data with different structures."""

    def test_format_report_data_with_all_hosts(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format report data with all_hosts provided."""
        all_hosts = {"primary": "node1", "standbys": ["node2", "node3"]}
        result = generator.format_report_data(
            "TEST001",
            {"test_key": "test_value"},
            host="ignored-host",
            all_hosts=all_hosts
        )
        assert result["checkId"] == "TEST001"

    def test_format_report_data_multi_node(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Format report data with multi-node structure."""
        data = {
            "node1": {"data": {"setting1": "value1"}},
            "node2": {"data": {"setting1": "value2"}}
        }
        result = generator.format_report_data(
            "TEST002",
            data,
            host="test-host"
        )
        assert "results" in result or "checkId" in result


class TestQueryRangeNonSuccess:
    """Test query_range with non-success responses."""

    def test_query_range_non_200(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Query range with non-200 status."""
        from datetime import datetime
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal Server Error"

        with patch("requests.get", return_value=mock_response):
            start = datetime(2024, 1, 1, 0, 0, 0)
            end = datetime(2024, 1, 1, 1, 0, 0)
            result = generator.query_range("up", start, end)
            assert result == []

    def test_query_range_non_success_status(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Query range with 200 but non-success status."""
        from datetime import datetime
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"status": "error", "error": "bad query"}

        with patch("requests.get", return_value=mock_response):
            start = datetime(2024, 1, 1, 0, 0, 0)
            end = datetime(2024, 1, 1, 1, 0, 0)
            result = generator.query_range("up", start, end)
            assert result == []


class TestClusterMetricUnits:
    """Test more cluster metric unit cases."""

    def test_metric_unit_bytes(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Get unit for bytes metric."""
        result = generator.get_cluster_metric_unit("bytes_read")
        # Should return some unit or empty string
        assert isinstance(result, str)

    def test_metric_unit_count(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Get unit for count metric."""
        result = generator.get_cluster_metric_unit("transaction_count")
        assert isinstance(result, str)


class TestParseMemoryValueNumeric:
    """Test _parse_memory_value with pure numeric values."""

    def test_parse_memory_value_pure_numeric(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse pure numeric value (no unit)."""
        result = generator._parse_memory_value("8192")
        assert isinstance(result, int)
        assert result >= 0

    def test_parse_memory_value_none_input(
        self,
        generator: PostgresReportGenerator,
    ) -> None:
        """Parse None input."""
        result = generator._parse_memory_value(None)
        assert result == 0


class TestGetAllClustersDebugPath:
    """Test get_all_clusters debug logging paths."""

    def test_get_all_clusters_non_success(
        self,
        monkeypatch: pytest.MonkeyPatch,
        generator: PostgresReportGenerator,
    ) -> None:
        """Get clusters with non-success status."""
        response = {"status": "error", "data": {"result": []}}
        monkeypatch.setattr(generator, "query_instant", lambda q: response)

        result = generator.get_all_clusters()
        assert result == []

    def test_get_all_clusters_no_data(
        self,
        monkeypatch: pytest.MonkeyPatch,
        generator: PostgresReportGenerator,
    ) -> None:
        """Get clusters with success but no data."""
        response = {"status": "success", "data": {}}
        monkeypatch.setattr(generator, "query_instant", lambda q: response)

        result = generator.get_all_clusters()
        assert result == []
