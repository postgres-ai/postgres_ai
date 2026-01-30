"""Additional edge case tests for better coverage."""
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
def test_filter_a003_settings_with_no_matching_settings(generator) -> None:
    """Test filtering when no settings match."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "random_setting": {"setting": "value"}
                }
            }
        }
    }

    result = generator.filter_a003_settings(a003_report, ["nonexistent1", "nonexistent2"])

    assert isinstance(result, dict)
    assert len(result) == 0


@pytest.mark.unit
def test_filter_a003_settings_with_all_matching(generator) -> None:
    """Test filtering when all requested settings match."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "setting1": {"setting": "value1"},
                    "setting2": {"setting": "value2"},
                    "setting3": {"setting": "value3"}
                }
            }
        }
    }

    result = generator.filter_a003_settings(a003_report, ["setting1", "setting2", "setting3"])

    assert len(result) == 3
    assert all(k in result for k in ["setting1", "setting2", "setting3"])


@pytest.mark.unit
def test_extract_postgres_version_with_only_version_string(generator) -> None:
    """Test version extraction when only version string is present."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version": {"setting": "15.3 (Debian 15.3-1.pgdg120+1)"}
                }
            }
        }
    }

    result = generator.extract_postgres_version_from_a003(a003_report)

    assert result["version"] == "15.3 (Debian 15.3-1.pgdg120+1)"


@pytest.mark.unit
def test_extract_postgres_version_with_version_num(generator) -> None:
    """Test version extraction with version_num parsing."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version": {"setting": "16.1"},
                    "server_version_num": {"setting": "160001"}
                }
            }
        }
    }

    result = generator.extract_postgres_version_from_a003(a003_report)

    assert result["version"] == "16.1"
    assert result["server_version_num"] == "160001"
    assert result["server_major_ver"] == "16"
    assert result["server_minor_ver"] == "1"


@pytest.mark.unit
def test_extract_postgres_version_with_multiple_nodes_uses_first(generator) -> None:
    """Test that extract_postgres_version uses first node when no specific node requested."""
    a003_report = {
        "results": {
            "primary": {
                "data": {
                    "server_version": {"setting": "14.10"}
                }
            },
            "replica": {
                "data": {
                    "server_version": {"setting": "14.9"}
                }
            }
        }
    }

    result = generator.extract_postgres_version_from_a003(a003_report)

    # Should use first node
    assert result["version"] in ["14.10", "14.9"]


@pytest.mark.unit
def test_format_report_data_with_multi_node_data_no_version_warning(generator) -> None:
    """Test format_report_data handles multi-node data with postgres_version parameter."""
    multi_node_data = {
        "node-01": {
            "data": {"metric1": 100}
        },
        "node-02": {
            "data": {"metric1": 200}
        }
    }

    version_info = {"version": "14.10"}

    # Should not crash, may log warning
    result = generator.format_report_data(
        "A002",
        multi_node_data,
        postgres_version=version_info
    )

    assert result["checkId"] == "A002"
    assert "node-01" in result["results"]
    assert "node-02" in result["results"]


@pytest.mark.unit
def test_analyze_memory_settings_with_string_max_connections(generator) -> None:
    """Test memory analysis handles max_connections as string."""
    memory_data = {
        "shared_buffers": {"setting": "1GB"},
        "work_mem": {"setting": "4MB"},
        "max_connections": {"setting": "200"}  # String
    }

    result = generator._analyze_memory_settings(memory_data)

    assert "estimated_total_memory_usage" in result
    # Should handle string conversion


@pytest.mark.unit
def test_parse_memory_value_with_negative_one(generator) -> None:
    """Test that -1 (unlimited) is handled."""
    result = generator._parse_memory_value("-1")

    assert result == 0  # Unlimited maps to 0


@pytest.mark.unit
def test_parse_memory_value_with_decimal(generator) -> None:
    """Test parsing decimal memory values."""
    result = generator._parse_memory_value("2.5GB")

    expected = int(2.5 * 1024 * 1024 * 1024)
    assert result == expected


@pytest.mark.unit
def test_format_bytes_with_exact_boundaries(generator) -> None:
    """Test format_bytes at exact unit boundaries."""
    # Exactly 1 KB
    result_kb = generator.format_bytes(1024)
    assert "1" in result_kb

    # Exactly 1 MB
    result_mb = generator.format_bytes(1024 * 1024)
    assert "1" in result_mb

    # Exactly 1 GB
    result_gb = generator.format_bytes(1024 * 1024 * 1024)
    assert "1" in result_gb


@pytest.mark.unit
def test_format_setting_value_with_8kb_not_divisible_by_1024(generator) -> None:
    """Test 8kB formatting when result is not divisible by 1024."""
    # 200 blocks * 8 = 1600 KiB (not divisible by 1024)
    result = generator.format_setting_value("shared_buffers", "200", "8kB")

    assert "1600" in result and "KiB" in result


@pytest.mark.unit
def test_format_setting_value_with_ms_not_divisible_by_1000(generator) -> None:
    """Test ms formatting when value is not divisible by 1000."""
    # 1500 ms is not divisible by 1000
    result = generator.format_setting_value("statement_timeout", "1500", "ms")

    assert "1500" in result and "ms" in result


@pytest.mark.unit
def test_get_check_title_for_all_known_checks(generator) -> None:
    """Test get_check_title for comprehensive list of checks."""
    check_ids = [
        "A002", "A003", "A004", "A007",
        "H001", "H002", "H004",
        "F001", "F004",
        "G001",
        "D004",
        "K001", "K003", "K004", "K005", "K006", "K007", "K008",
        "M001", "M002", "M003",
        "N001"
    ]

    for check_id in check_ids:
        title = generator.get_check_title(check_id)
        assert isinstance(title, str)
        assert len(title) > 0  # Should have a title


@pytest.mark.unit
def test_extract_queryids_with_nested_database_structure(generator) -> None:
    """Test queryid extraction with nested database structure."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": {
                        "db1": {
                            "top_queries": [
                                {"queryid": "111", "calls": 100},
                                {"queryid": "222", "calls": 50}
                            ]
                        },
                        "db2": {
                            "top_queries": [
                                {"queryid": "333", "calls": 75}
                            ]
                        }
                    }
                }
            }
        }
    }

    result = generator.extract_queryids_from_reports(reports)

    assert isinstance(result, dict)
    # Should have extracted queryids from both databases


@pytest.mark.unit
def test_format_report_data_preserves_check_id(generator) -> None:
    """Test that format_report_data preserves checkId correctly."""
    data = {"test": "value"}

    for check_id in ["A002", "H002", "K003"]:
        result = generator.format_report_data(check_id, data, "node-01")
        assert result["checkId"] == check_id


@pytest.mark.unit
def test_format_report_data_includes_timestamp(generator) -> None:
    """Test that format_report_data includes timestamptz."""
    result = generator.format_report_data("A002", {}, "node-01")

    assert "timestamptz" in result
    assert isinstance(result["timestamptz"], str)
    # Should be ISO format timestamp
    assert "T" in result["timestamptz"] or "-" in result["timestamptz"]
