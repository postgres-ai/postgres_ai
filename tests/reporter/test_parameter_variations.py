"""Tests with various parameter combinations to hit different code paths."""
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


@pytest.fixture
def mock_success_result():
    """Mock successful Prometheus result."""
    return {"status": "success", "data": {"result": []}}


# Tests for different cluster/node combinations


@pytest.mark.unit
def test_generate_a002_with_non_default_cluster(generator, mock_success_result) -> None:
    """Test A002 with non-default cluster name."""
    with patch.object(generator, 'query_instant', return_value=mock_success_result):
        report = generator.generate_a002_version_report("production-db", "primary-node")

    assert report["checkId"] == "A002"


@pytest.mark.unit
def test_generate_a003_with_special_characters_in_cluster(generator, mock_success_result) -> None:
    """Test A003 with special characters in cluster name."""
    with patch.object(generator, 'query_instant', return_value=mock_success_result):
        with patch.object(generator, '_get_postgres_version_info', return_value={}):
            report = generator.generate_a003_settings_report("cluster-with-dashes", "node_01")

    assert report["checkId"] == "A003"


@pytest.mark.unit
def test_generate_h002_with_multiple_databases(generator, mock_success_result) -> None:
    """Test H002 with multiple databases."""
    with patch.object(generator, 'query_instant', return_value=mock_success_result):
        with patch.object(generator, 'get_all_databases', return_value=["db1", "db2", "db3"]):
            report = generator.generate_h002_unused_indexes_report("test-cluster", "node-01")

    assert report["checkId"] == "H002"


@pytest.mark.unit
def test_generate_h004_with_single_database(generator, mock_success_result) -> None:
    """Test H004 with single database."""
    with patch.object(generator, 'query_instant', return_value=mock_success_result):
        with patch.object(generator, 'get_all_databases', return_value=["onlydb"]):
            report = generator.generate_h004_redundant_indexes_report("test-cluster", "node-01")

    assert report["checkId"] == "H004"


@pytest.mark.unit
def test_generate_f001_with_default_parameters(generator, mock_success_result) -> None:
    """Test F001 with default parameters."""
    with patch.object(generator, 'query_instant', return_value=mock_success_result):
        report = generator.generate_f001_autovacuum_settings_report()

    assert report["checkId"] == "F001"


@pytest.mark.unit
def test_generate_g001_with_default_parameters(generator, mock_success_result) -> None:
    """Test G001 with default parameters."""
    with patch.object(generator, 'query_instant', return_value=mock_success_result):
        report = generator.generate_g001_memory_settings_report()

    assert report["checkId"] == "G001"


@pytest.mark.unit
def test_generate_d004_with_default_parameters(generator, mock_success_result) -> None:
    """Test D004 with default parameters."""
    with patch.object(generator, 'query_instant', return_value=mock_success_result):
        report = generator.generate_d004_pgstat_settings_report()

    assert report["checkId"] == "D004"


# Tests with error responses


@pytest.mark.unit
def test_generate_a002_with_error_status(generator) -> None:
    """Test A002 when Prometheus returns error status."""
    error_result = {
        "status": "error",
        "error": "Query timeout"
    }

    with patch.object(generator, 'query_instant', return_value=error_result):
        report = generator.generate_a002_version_report("test-cluster", "node-01")

    # Should still return a report structure
    assert "checkId" in report or "results" in report


@pytest.mark.unit
def test_generate_a003_with_partial_data(generator) -> None:
    """Test A003 with partial settings data."""
    partial_result = {
        "status": "success",
        "data": {
            "result": [
                {
                    "metric": {"setting": "shared_buffers"},
                    "value": [1234567890, "128MB"]
                }
            ]
        }
    }

    with patch.object(generator, 'query_instant', return_value=partial_result):
        with patch.object(generator, '_get_postgres_version_info', return_value={}):
            report = generator.generate_a003_settings_report("test-cluster", "node-01")

    assert report["checkId"] == "A003"


# Tests for format methods with edge cases


@pytest.mark.unit
def test_format_report_data_with_long_check_id(generator) -> None:
    """Test format_report_data with unusually long check ID."""
    result = generator.format_report_data("CUSTOM_VERY_LONG_CHECK_ID_12345", {}, "node-01")

    assert result["checkId"] == "CUSTOM_VERY_LONG_CHECK_ID_12345"


@pytest.mark.unit
def test_format_report_data_with_numeric_host(generator) -> None:
    """Test format_report_data with numeric host identifier."""
    result = generator.format_report_data("A002", {}, "12345")

    assert "12345" in result["results"]


@pytest.mark.unit
def test_format_report_data_with_many_standbys(generator) -> None:
    """Test format_report_data with many standby nodes."""
    all_hosts = {
        "primary": "node-01",
        "standbys": [f"replica-{i}" for i in range(1, 11)]  # 10 replicas
    }

    result = generator.format_report_data("A002", {}, all_hosts=all_hosts)

    assert len(result["nodes"]["standbys"]) == 10


# Tests for setting filtering with various inputs


@pytest.mark.unit
def test_filter_a003_settings_with_very_long_list(generator) -> None:
    """Test filtering with very long settings list."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {f"setting_{i}": {"setting": f"value_{i}"} for i in range(100)}
            }
        }
    }

    # Request 50 of them
    settings_to_filter = [f"setting_{i}" for i in range(0, 100, 2)]  # Every other one

    result = generator.filter_a003_settings(a003_report, settings_to_filter)

    assert len(result) == 50


@pytest.mark.unit
def test_filter_a003_settings_preserves_structure(generator) -> None:
    """Test that filtering preserves the original setting structure."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "max_connections": {
                        "setting": "100",
                        "unit": None,
                        "category": "Connections"
                    }
                }
            }
        }
    }

    result = generator.filter_a003_settings(a003_report, ["max_connections"])

    # Should preserve all fields
    assert result["max_connections"]["setting"] == "100"
    assert result["max_connections"]["unit"] is None
    assert result["max_connections"]["category"] == "Connections"


# Tests for memory parsing edge cases


@pytest.mark.unit
def test_parse_memory_value_with_mixed_case_units(generator) -> None:
    """Test parsing with various mixed case unit combinations."""
    test_cases = [
        ("128Mb", 128 * 1024 * 1024),
        ("4Gb", 4 * 1024 * 1024 * 1024),
        ("2Tb", 2 * 1024 * 1024 * 1024 * 1024),
    ]

    for value, expected in test_cases:
        result = generator._parse_memory_value(value)
        assert result == expected, f"Failed for {value}"


@pytest.mark.unit
def test_parse_memory_value_with_float_values(generator) -> None:
    """Test parsing memory values with decimal points."""
    test_cases = [
        ("1.5MB", int(1.5 * 1024 * 1024)),
        ("0.5GB", int(0.5 * 1024 * 1024 * 1024)),
        ("2.25GB", int(2.25 * 1024 * 1024 * 1024)),
    ]

    for value, expected in test_cases:
        result = generator._parse_memory_value(value)
        assert result == expected, f"Failed for {value}"


# Tests for version extraction variations


@pytest.mark.unit
def test_extract_postgres_version_with_development_version(generator) -> None:
    """Test version extraction with development version string."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version": {"setting": "17devel"},
                    "server_version_num": {"setting": "170000"}
                }
            }
        }
    }

    result = generator.extract_postgres_version_from_a003(a003_report)

    assert result["version"] == "17devel"
    assert result["server_major_ver"] == "17"


@pytest.mark.unit
def test_extract_postgres_version_with_beta_version(generator) -> None:
    """Test version extraction with beta version string."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version": {"setting": "16beta1"},
                    "server_version_num": {"setting": "160000"}
                }
            }
        }
    }

    result = generator.extract_postgres_version_from_a003(a003_report)

    assert "16" in result["version"] or "beta" in result["version"]


# Tests for queryid extraction variations


@pytest.mark.unit
def test_extract_queryids_with_very_large_queryid(generator) -> None:
    """Test queryid extraction with very large queryid values."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": {
                        "db1": {
                            "top_queries": [
                                {"queryid": "9223372036854775807", "calls": 100},  # Max int64
                            ]
                        }
                    }
                }
            }
        }
    }

    result = generator.extract_queryids_from_reports(reports)

    assert isinstance(result, dict)


@pytest.mark.unit
def test_extract_queryids_with_negative_queryid(generator) -> None:
    """Test queryid extraction with negative queryid."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": {
                        "db1": {
                            "top_queries": [
                                {"queryid": "-12345", "calls": 100},
                            ]
                        }
                    }
                }
            }
        }
    }

    result = generator.extract_queryids_from_reports(reports)

    assert isinstance(result, dict)


# Tests for check title edge cases


@pytest.mark.unit
def test_get_check_title_with_lowercase_check_id(generator) -> None:
    """Test get_check_title with lowercase check ID."""
    # Might handle case-insensitively or return empty
    result = generator.get_check_title("a002")

    assert isinstance(result, str)


@pytest.mark.unit
def test_get_check_title_with_number_only(generator) -> None:
    """Test get_check_title with number-only check ID."""
    result = generator.get_check_title("001")

    assert isinstance(result, str)


@pytest.mark.unit
def test_get_check_title_with_special_characters(generator) -> None:
    """Test get_check_title with special characters."""
    result = generator.get_check_title("A@002")

    assert isinstance(result, str)
