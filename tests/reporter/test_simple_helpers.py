"""Tests for simple helper methods and utilities."""
import pytest
from unittest.mock import patch, MagicMock

from reporter.postgres_reports import PostgresReportGenerator


@pytest.fixture
def generator():
    """Create a generator instance for testing."""
    return PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
    )


@pytest.mark.unit
def test_get_check_title_returns_string(generator) -> None:
    """Test that get_check_title always returns a string."""
    # Test with various check IDs
    for check_id in ["A002", "H002", "F004", "K003", "M001", "UNKNOWN"]:
        result = generator.get_check_title(check_id)
        assert isinstance(result, str)
        assert len(result) >= 0  # Should return something (even empty string is ok)


@pytest.mark.unit
def test_format_bytes_returns_string(generator) -> None:
    """Test that format_bytes always returns a string."""
    test_values = [0, 1, 1024, 1024*1024, 1024*1024*1024]

    for value in test_values:
        result = generator.format_bytes(value)
        assert isinstance(result, str)
        assert len(result) > 0


@pytest.mark.unit
def test_parse_memory_value_returns_int(generator) -> None:
    """Test that _parse_memory_value always returns an integer."""
    test_values = ["0", "128MB", "4GB", "1024kB", "invalid", "-1"]

    for value in test_values:
        result = generator._parse_memory_value(value)
        assert isinstance(result, int)
        assert result >= 0  # Should never return negative


@pytest.mark.unit
def test_format_setting_value_returns_string(generator) -> None:
    """Test that format_setting_value always returns a string."""
    test_cases = [
        ("max_connections", "100", ""),
        ("shared_buffers", "128", "8kB"),
        ("work_mem", "4", "MB"),
        ("statement_timeout", "30", "s"),
    ]

    for setting_name, value, unit in test_cases:
        result = generator.format_setting_value(setting_name, value, unit)
        assert isinstance(result, str)
        assert len(result) > 0


@pytest.mark.unit
def test_filter_a003_settings_returns_dict(generator) -> None:
    """Test that filter_a003_settings always returns a dict."""
    test_report = {
        "results": {
            "node-01": {
                "data": {
                    "shared_buffers": {"setting": "128MB"},
                    "work_mem": {"setting": "4MB"},
                    "max_connections": {"setting": "100"}
                }
            }
        }
    }

    result = generator.filter_a003_settings(test_report, ["shared_buffers", "work_mem"])
    assert isinstance(result, dict)
    assert "shared_buffers" in result
    assert "work_mem" in result
    assert "max_connections" not in result


@pytest.mark.unit
def test_extract_postgres_version_from_a003_returns_dict(generator) -> None:
    """Test that extract_postgres_version_from_a003 always returns a dict."""
    test_cases = [
        {"results": {}},  # Empty
        {"results": {"node-01": {"data": {}}}},  # No version
        {"results": {"node-01": {"data": {"server_version": {"setting": "14.10"}}}}},  # With version
    ]

    for test_report in test_cases:
        result = generator.extract_postgres_version_from_a003(test_report)
        assert isinstance(result, dict)


@pytest.mark.unit
def test_extract_queryids_from_reports_returns_dict(generator) -> None:
    """Test that extract_queryids_from_reports always returns a dict."""
    test_cases = [
        {},  # Empty
        {"K003": {"results": {}}},  # No data
        {"K003": {"results": {"node-01": {"data": {}}}}},  # Empty data
    ]

    for test_reports in test_cases:
        result = generator.extract_queryids_from_reports(test_reports)
        assert isinstance(result, dict)


@pytest.mark.unit
def test_format_report_data_returns_dict(generator) -> None:
    """Test that format_report_data always returns properly formatted dict."""
    test_data = {"setting1": "value1", "setting2": "value2"}

    result = generator.format_report_data("A003", test_data, "node-01")

    assert isinstance(result, dict)
    assert "checkId" in result
    assert "results" in result
    assert "timestamptz" in result
    assert result["checkId"] == "A003"


@pytest.mark.unit
def test_format_report_data_with_postgres_version(generator) -> None:
    """Test format_report_data includes postgres_version when provided."""
    test_data = {"setting1": "value1"}
    version_info = {"version": "14.10", "server_major_ver": "14"}

    result = generator.format_report_data(
        "A003",
        test_data,
        "node-01",
        postgres_version=version_info
    )

    assert "results" in result
    assert "node-01" in result["results"]
    assert "postgres_version" in result["results"]["node-01"]


@pytest.mark.unit
def test_build_metadata_has_expected_keys(generator) -> None:
    """Test that _build_metadata dict has expected structure."""
    metadata = generator._build_metadata

    assert isinstance(metadata, dict)
    # May have version, build_ts, or be empty
    for key in metadata.keys():
        assert isinstance(key, str)


@pytest.mark.unit
def test_d004_settings_is_non_empty_list(generator) -> None:
    """Test that D004_SETTINGS constant is properly defined."""
    assert isinstance(generator.D004_SETTINGS, list)
    assert len(generator.D004_SETTINGS) > 0
    assert "pg_stat_statements.max" in generator.D004_SETTINGS


@pytest.mark.unit
def test_f001_settings_is_non_empty_list(generator) -> None:
    """Test that F001_SETTINGS constant is properly defined."""
    assert isinstance(generator.F001_SETTINGS, list)
    assert len(generator.F001_SETTINGS) > 0
    assert "autovacuum" in generator.F001_SETTINGS


@pytest.mark.unit
def test_g001_settings_is_non_empty_list(generator) -> None:
    """Test that G001_SETTINGS constant is properly defined."""
    assert isinstance(generator.G001_SETTINGS, list)
    assert len(generator.G001_SETTINGS) > 0
    assert "shared_buffers" in generator.G001_SETTINGS


@pytest.mark.unit
def test_analyze_memory_settings_returns_dict(generator) -> None:
    """Test that _analyze_memory_settings always returns a dict."""
    test_cases = [
        {},  # Empty
        {"shared_buffers": {"setting": "128MB"}},  # Partial
        {
            "shared_buffers": {"setting": "1GB"},
            "work_mem": {"setting": "4MB"},
            "max_connections": {"setting": "100"}
        },  # Complete
    ]

    for memory_data in test_cases:
        result = generator._analyze_memory_settings(memory_data)
        assert isinstance(result, dict)
        assert "estimated_total_memory_usage" in result


@pytest.mark.unit
def test_prometheus_url_is_set(generator) -> None:
    """Test that prometheus_url is properly set."""
    assert generator.prometheus_url == "http://prom.test"
    assert isinstance(generator.prometheus_url, str)


@pytest.mark.unit
def test_postgres_sink_url_is_set(generator) -> None:
    """Test that postgres_sink_url has a value."""
    assert generator.postgres_sink_url is not None
    assert isinstance(generator.postgres_sink_url, str)


@pytest.mark.unit
def test_pg_conn_is_initially_none(generator) -> None:
    """Test that pg_conn starts as None."""
    assert generator.pg_conn is None
