"""Tests for version extraction and memory parsing."""
import pytest

from reporter.postgres_reports import PostgresReportGenerator


@pytest.fixture
def generator():
    """Create a generator instance for testing."""
    return PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
    )


@pytest.mark.unit
def test_extract_postgres_version_from_a003_with_full_data(generator) -> None:
    """Test extracting version from A003 report with complete data."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version": {
                        "setting": "14.10 (Ubuntu 14.10-1.pgdg22.04+1)"
                    },
                    "server_version_num": {
                        "setting": "140010"
                    }
                }
            }
        }
    }

    version_info = generator.extract_postgres_version_from_a003(a003_report)

    assert version_info["version"] == "14.10 (Ubuntu 14.10-1.pgdg22.04+1)"
    assert version_info["server_version_num"] == "140010"
    assert version_info["server_major_ver"] == "14"
    assert version_info["server_minor_ver"] == "10"


@pytest.mark.unit
def test_extract_postgres_version_from_a003_with_postgres_version_field(generator) -> None:
    """Test extracting version when postgres_version field already exists."""
    a003_report = {
        "results": {
            "node-01": {
                "postgres_version": {
                    "version": "15.3",
                    "server_version_num": "150003",
                    "server_major_ver": "15",
                    "server_minor_ver": "3"
                },
                "data": {}
            }
        }
    }

    version_info = generator.extract_postgres_version_from_a003(a003_report)

    assert version_info["version"] == "15.3"
    assert version_info["server_version_num"] == "150003"
    assert version_info["server_major_ver"] == "15"
    assert version_info["server_minor_ver"] == "3"


@pytest.mark.unit
def test_extract_postgres_version_from_a003_with_specific_node(generator) -> None:
    """Test extracting version for a specific node."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version": {"setting": "14.10"},
                    "server_version_num": {"setting": "140010"}
                }
            },
            "node-02": {
                "data": {
                    "server_version": {"setting": "15.3"},
                    "server_version_num": {"setting": "150003"}
                }
            }
        }
    }

    version_info = generator.extract_postgres_version_from_a003(a003_report, node_name="node-02")

    assert version_info["version"] == "15.3"
    assert version_info["server_major_ver"] == "15"
    assert version_info["server_minor_ver"] == "3"


@pytest.mark.unit
def test_extract_postgres_version_from_a003_with_empty_results(generator) -> None:
    """Test extracting version from empty results."""
    a003_report = {
        "results": {}
    }

    version_info = generator.extract_postgres_version_from_a003(a003_report)

    assert version_info == {}


@pytest.mark.unit
def test_extract_postgres_version_from_a003_with_missing_version_data(generator) -> None:
    """Test extracting version when version data is missing."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {}
            }
        }
    }

    version_info = generator.extract_postgres_version_from_a003(a003_report)

    assert version_info == {}


@pytest.mark.unit
def test_extract_postgres_version_from_a003_with_only_version_num(generator) -> None:
    """Test extracting version with only version_num."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version_num": {"setting": "160000"}
                }
            }
        }
    }

    version_info = generator.extract_postgres_version_from_a003(a003_report)

    assert version_info["server_version_num"] == "160000"
    assert version_info["server_major_ver"] == "16"
    assert version_info["server_minor_ver"] == "0"
    assert version_info["version"] == ""


@pytest.mark.unit
def test_extract_postgres_version_from_a003_with_invalid_version_num(generator) -> None:
    """Test extracting version with invalid version_num."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version": {"setting": "14.10"},
                    "server_version_num": {"setting": "invalid"}
                }
            }
        }
    }

    version_info = generator.extract_postgres_version_from_a003(a003_report)

    assert version_info["version"] == "14.10"
    assert version_info["server_version_num"] == "invalid"
    # Major/minor should be empty strings when parsing fails
    assert version_info["server_major_ver"] == ""
    assert version_info["server_minor_ver"] == ""


@pytest.mark.unit
def test_extract_postgres_version_from_a003_with_short_version_num(generator) -> None:
    """Test extracting version with version_num shorter than 6 digits."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "server_version_num": {"setting": "12345"}  # Only 5 digits
                }
            }
        }
    }

    version_info = generator.extract_postgres_version_from_a003(a003_report)

    # Should still try to parse but get empty strings
    assert version_info["server_version_num"] == "12345"
    assert version_info["server_major_ver"] == ""
    assert version_info["server_minor_ver"] == ""


@pytest.mark.unit
def test_extract_postgres_version_uses_first_node_when_no_node_specified(generator) -> None:
    """Test that first node is used when node_name is not specified."""
    a003_report = {
        "results": {
            "node-02": {
                "data": {
                    "server_version": {"setting": "15.3"},
                    "server_version_num": {"setting": "150003"}
                }
            },
            "node-01": {
                "data": {
                    "server_version": {"setting": "14.10"},
                    "server_version_num": {"setting": "140010"}
                }
            }
        }
    }

    version_info = generator.extract_postgres_version_from_a003(a003_report)

    # Should use first node (node-02 in this case, as dicts preserve insertion order in Python 3.7+)
    assert version_info["version"] == "15.3"


@pytest.mark.unit
def test_parse_memory_value_bytes(generator) -> None:
    """Test parsing memory values without units (assumes KB)."""
    # Bare numbers are assumed to be in KB
    assert generator._parse_memory_value("1024") == 1024 * 1024
    assert generator._parse_memory_value("0") == 0
    assert generator._parse_memory_value("128") == 128 * 1024


@pytest.mark.unit
def test_parse_memory_value_kb(generator) -> None:
    """Test parsing memory values in KB."""
    assert generator._parse_memory_value("128kB") == 128 * 1024
    assert generator._parse_memory_value("1kB") == 1024
    assert generator._parse_memory_value("1024kB") == 1024 * 1024


@pytest.mark.unit
def test_parse_memory_value_mb(generator) -> None:
    """Test parsing memory values in MB."""
    assert generator._parse_memory_value("128MB") == 128 * 1024 * 1024
    assert generator._parse_memory_value("1MB") == 1024 * 1024
    assert generator._parse_memory_value("2048MB") == 2048 * 1024 * 1024


@pytest.mark.unit
def test_parse_memory_value_gb(generator) -> None:
    """Test parsing memory values in GB."""
    assert generator._parse_memory_value("1GB") == 1024 * 1024 * 1024
    assert generator._parse_memory_value("4GB") == 4 * 1024 * 1024 * 1024
    assert generator._parse_memory_value("16GB") == 16 * 1024 * 1024 * 1024


@pytest.mark.unit
def test_parse_memory_value_tb(generator) -> None:
    """Test parsing memory values in TB."""
    assert generator._parse_memory_value("1TB") == 1024 * 1024 * 1024 * 1024
    assert generator._parse_memory_value("2TB") == 2 * 1024 * 1024 * 1024 * 1024


@pytest.mark.unit
def test_parse_memory_value_case_insensitive(generator) -> None:
    """Test that memory parsing is case-insensitive."""
    assert generator._parse_memory_value("128KB") == 128 * 1024
    assert generator._parse_memory_value("128kb") == 128 * 1024
    assert generator._parse_memory_value("128Kb") == 128 * 1024
    assert generator._parse_memory_value("1mb") == 1024 * 1024
    assert generator._parse_memory_value("1Mb") == 1024 * 1024


@pytest.mark.unit
def test_parse_memory_value_with_spaces(generator) -> None:
    """Test parsing memory values with spaces."""
    assert generator._parse_memory_value("128 MB") == 128 * 1024 * 1024
    assert generator._parse_memory_value("1 GB") == 1024 * 1024 * 1024
    assert generator._parse_memory_value("  256  kB  ") == 256 * 1024


@pytest.mark.unit
def test_parse_memory_value_invalid_format(generator) -> None:
    """Test parsing invalid memory values."""
    # Empty string and invalid strings without units return 0 (caught by try-except)
    assert generator._parse_memory_value("") == 0
    assert generator._parse_memory_value("invalid") == 0  # No unit, caught by except ValueError

    # Values with unit suffixes but invalid numbers raise ValueError (not caught)
    with pytest.raises(ValueError):
        generator._parse_memory_value("abc123MB")  # Invalid number with MB suffix

    with pytest.raises(ValueError):
        generator._parse_memory_value("invalidGB")  # Invalid number with GB suffix


@pytest.mark.unit
def test_parse_memory_value_decimal_numbers(generator) -> None:
    """Test parsing memory values with decimal numbers."""
    assert generator._parse_memory_value("1.5GB") == int(1.5 * 1024 * 1024 * 1024)
    assert generator._parse_memory_value("0.5MB") == int(0.5 * 1024 * 1024)
    assert generator._parse_memory_value("128.256kB") == int(128.256 * 1024)


@pytest.mark.unit
def test_parse_memory_value_negative_one(generator) -> None:
    """Test that -1 (unlimited) returns 0."""
    assert generator._parse_memory_value("-1") == 0


@pytest.mark.unit
def test_parse_memory_value_with_b_suffix(generator) -> None:
    """Test parsing values with B suffix."""
    assert generator._parse_memory_value("1024B") == 1024
    assert generator._parse_memory_value("512B") == 512
