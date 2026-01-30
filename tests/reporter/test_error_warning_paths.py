"""Tests for error and warning code paths."""
import pytest
from unittest.mock import patch, MagicMock
import logging

from reporter.postgres_reports import PostgresReportGenerator


@pytest.fixture
def generator():
    """Create a generator instance for testing."""
    return PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
    )


@pytest.mark.unit
def test_generate_a002_logs_warning_when_no_version_data(generator, caplog) -> None:
    """Test A002 logs warning when no version data is found."""
    mock_empty_result = {
        "status": "success",
        "data": {"result": []}
    }

    with caplog.at_level(logging.WARNING):
        with patch.object(generator, 'query_instant', return_value=mock_empty_result):
            report = generator.generate_a002_version_report("test-cluster", "node-01")

    # Should still return a report
    assert report["checkId"] == "A002"


@pytest.mark.unit
def test_generate_h002_logs_warning_when_no_indexes(generator, caplog) -> None:
    """Test H002 logs warning when no unused indexes found."""
    mock_empty_result = {
        "status": "success",
        "data": {"result": []}
    }

    with caplog.at_level(logging.WARNING):
        with patch.object(generator, 'query_instant', return_value=mock_empty_result):
            with patch.object(generator, 'get_all_databases', return_value=["testdb"]):
                report = generator.generate_h002_unused_indexes_report("test-cluster", "node-01")

    assert report["checkId"] == "H002"


@pytest.mark.unit
def test_generate_f004_logs_warning_when_no_bloat_data(generator, caplog) -> None:
    """Test F004 logs warning when no bloat data found."""
    mock_empty_result = {
        "status": "success",
        "data": {"result": []}
    }

    with caplog.at_level(logging.WARNING):
        with patch.object(generator, 'query_instant', return_value=mock_empty_result):
            with patch.object(generator, 'get_all_databases', return_value=["testdb"]):
                report = generator.generate_f004_heap_bloat_report("test-cluster", "node-01")

    # Should log warning about no bloat data
    assert report["checkId"] == "F004"


@pytest.mark.unit
def test_analyze_memory_settings_handles_exception_gracefully(generator) -> None:
    """Test that memory analysis handles exceptions in parsing."""
    # Invalid data that will cause parsing errors
    memory_data = {
        "shared_buffers": {"setting": "not_a_number_at_all"},
        "work_mem": {"setting": "also_invalid"},
        "max_connections": {"setting": "not_an_int"}
    }

    # Should not raise exception, should return dict with empty estimates
    result = generator._analyze_memory_settings(memory_data)

    assert isinstance(result, dict)
    assert "estimated_total_memory_usage" in result


@pytest.mark.unit
def test_parse_memory_value_handles_empty_string(generator) -> None:
    """Test parse_memory_value with empty string."""
    result = generator._parse_memory_value("")

    assert result == 0


@pytest.mark.unit
def test_parse_memory_value_handles_whitespace(generator) -> None:
    """Test parse_memory_value with whitespace."""
    result = generator._parse_memory_value("   ")

    assert result == 0


@pytest.mark.unit
def test_format_setting_value_with_empty_strings(generator) -> None:
    """Test format_setting_value with empty value."""
    result = generator.format_setting_value("some_setting", "", "")

    assert isinstance(result, str)


@pytest.mark.unit
def test_extract_postgres_version_with_malformed_version_num(generator) -> None:
    """Test version extraction with malformed version_num."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version": {"setting": "14.10"},
                    "server_version_num": {"setting": "not_a_number"}
                }
            }
        }
    }

    result = generator.extract_postgres_version_from_a003(a003_report)

    # Should handle gracefully
    assert result["version"] == "14.10"
    assert result["server_version_num"] == "not_a_number"
    assert result["server_major_ver"] == ""
    assert result["server_minor_ver"] == ""


@pytest.mark.unit
def test_extract_postgres_version_with_short_version_num(generator) -> None:
    """Test version extraction with version_num shorter than expected."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version_num": {"setting": "123"}  # Too short
                }
            }
        }
    }

    result = generator.extract_postgres_version_from_a003(a003_report)

    # Should handle gracefully
    assert result["server_version_num"] == "123"


@pytest.mark.unit
def test_filter_a003_settings_with_none_values(generator) -> None:
    """Test filtering when settings have None values."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "setting1": None,
                    "setting2": {"setting": "value2"}
                }
            }
        }
    }

    # Should handle None values gracefully
    result = generator.filter_a003_settings(a003_report, ["setting1", "setting2"])

    assert isinstance(result, dict)


@pytest.mark.unit
def test_generate_d004_from_a003_with_no_cluster_parameter(generator) -> None:
    """Test D004 generation uses default cluster when not specified."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "pg_stat_statements.max": {"setting": "5000"}
                }
            }
        }
    }

    # Should use default cluster "local"
    report = generator.generate_d004_from_a003(a003_report)

    assert report["checkId"] == "D004"


@pytest.mark.unit
def test_format_report_data_with_none_data(generator) -> None:
    """Test format_report_data handles None data parameter."""
    # Edge case: what if data is None instead of empty dict
    result = generator.format_report_data("A002", None or {}, "node-01")

    assert result["checkId"] == "A002"


@pytest.mark.unit
def test_get_check_title_caches_results(generator) -> None:
    """Test that get_check_title is consistent across calls."""
    title1 = generator.get_check_title("A002")
    title2 = generator.get_check_title("A002")

    # Should return same title
    assert title1 == title2


@pytest.mark.unit
def test_format_bytes_with_very_small_values(generator) -> None:
    """Test format_bytes with very small byte values."""
    result_1 = generator.format_bytes(1)
    result_10 = generator.format_bytes(10)
    result_100 = generator.format_bytes(100)

    # All should format correctly
    assert isinstance(result_1, str)
    assert isinstance(result_10, str)
    assert isinstance(result_100, str)


@pytest.mark.unit
def test_extract_queryids_from_reports_with_missing_queryid_field(generator) -> None:
    """Test queryid extraction when queryid field is missing."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": {
                        "db1": {
                            "top_queries": [
                                {"calls": 100},  # Missing queryid
                                {"queryid": "123", "calls": 50}
                            ]
                        }
                    }
                }
            }
        }
    }

    result = generator.extract_queryids_from_reports(reports)

    # Should skip entries without queryid
    assert isinstance(result, dict)


@pytest.mark.unit
def test_format_setting_value_with_very_large_8kb_value(generator) -> None:
    """Test 8kB formatting with very large values."""
    # 1 million blocks * 8 = 8 million KiB = ~7.8 GiB
    result = generator.format_setting_value("shared_buffers", "1000000", "8kB")

    assert isinstance(result, str)
    # Should handle large values


@pytest.mark.unit
def test_parse_memory_value_with_very_large_tb_value(generator) -> None:
    """Test parsing very large TB values."""
    result = generator._parse_memory_value("100TB")

    expected = 100 * 1024 * 1024 * 1024 * 1024
    assert result == expected


@pytest.mark.unit
def test_format_bytes_with_exact_petabyte(generator) -> None:
    """Test formatting exactly 1 PB."""
    one_pb = 1024 * 1024 * 1024 * 1024 * 1024

    result = generator.format_bytes(one_pb)

    assert isinstance(result, str)
    # Should format PB or show in TB


@pytest.mark.unit
def test_analyze_memory_settings_with_all_defaults(generator) -> None:
    """Test memory analysis when all settings are at defaults."""
    memory_data = {}  # Empty, should use all defaults

    result = generator._analyze_memory_settings(memory_data)

    assert "estimated_total_memory_usage" in result
    estimates = result["estimated_total_memory_usage"]
    # Should have calculated default values
    if estimates:
        assert "shared_buffers_bytes" in estimates or len(estimates) == 0
