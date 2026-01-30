"""Tests for A003 settings filtering functionality."""
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
def test_filter_a003_settings_with_single_node(generator) -> None:
    """Test filtering settings from A003 report with single node."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "shared_buffers": {
                        "setting": "128MB",
                        "unit": "8kB",
                        "category": "Resource Usage / Memory"
                    },
                    "work_mem": {
                        "setting": "4MB",
                        "unit": "kB",
                        "category": "Resource Usage / Memory"
                    },
                    "max_connections": {
                        "setting": "100",
                        "unit": None,
                        "category": "Connections and Authentication / Connection Settings"
                    },
                    "log_statement": {
                        "setting": "none",
                        "unit": None,
                        "category": "Reporting and Logging / What to Log"
                    }
                }
            }
        }
    }

    # Filter for G001 memory settings
    filtered = generator.filter_a003_settings(
        a003_report,
        ["shared_buffers", "work_mem"]
    )

    assert "shared_buffers" in filtered
    assert "work_mem" in filtered
    assert "max_connections" not in filtered
    assert "log_statement" not in filtered
    assert filtered["shared_buffers"]["setting"] == "128MB"
    assert filtered["work_mem"]["setting"] == "4MB"


@pytest.mark.unit
def test_filter_a003_settings_with_multiple_nodes(generator) -> None:
    """Test filtering settings from A003 report with multiple nodes."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "shared_buffers": {"setting": "128MB"},
                    "work_mem": {"setting": "4MB"},
                    "max_connections": {"setting": "100"}
                }
            },
            "node-02": {
                "data": {
                    "shared_buffers": {"setting": "256MB"},
                    "work_mem": {"setting": "8MB"},
                    "max_connections": {"setting": "200"}
                }
            }
        }
    }

    filtered = generator.filter_a003_settings(
        a003_report,
        ["shared_buffers", "work_mem"]
    )

    # Should include settings from all nodes (last one wins in current implementation)
    assert "shared_buffers" in filtered
    assert "work_mem" in filtered
    assert "max_connections" not in filtered


@pytest.mark.unit
def test_filter_a003_settings_with_missing_settings(generator) -> None:
    """Test filtering when requested settings don't exist."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "shared_buffers": {"setting": "128MB"},
                    "max_connections": {"setting": "100"}
                }
            }
        }
    }

    # Request settings that don't exist
    filtered = generator.filter_a003_settings(
        a003_report,
        ["work_mem", "maintenance_work_mem", "effective_cache_size"]
    )

    # Should return empty dict since none of the requested settings exist
    assert filtered == {}


@pytest.mark.unit
def test_filter_a003_settings_with_empty_results(generator) -> None:
    """Test filtering with empty results."""
    a003_report = {
        "results": {}
    }

    filtered = generator.filter_a003_settings(
        a003_report,
        ["shared_buffers", "work_mem"]
    )

    assert filtered == {}


@pytest.mark.unit
def test_filter_a003_settings_with_empty_setting_names(generator) -> None:
    """Test filtering with empty setting names list."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "shared_buffers": {"setting": "128MB"},
                    "work_mem": {"setting": "4MB"}
                }
            }
        }
    }

    filtered = generator.filter_a003_settings(a003_report, [])

    assert filtered == {}


@pytest.mark.unit
def test_filter_a003_settings_partial_match(generator) -> None:
    """Test filtering with partial match - some settings exist, some don't."""
    a003_report = {
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

    # Request mix of existing and non-existing settings
    filtered = generator.filter_a003_settings(
        a003_report,
        ["shared_buffers", "non_existent_setting", "work_mem", "another_missing"]
    )

    # Should only return existing settings
    assert len(filtered) == 2
    assert "shared_buffers" in filtered
    assert "work_mem" in filtered
    assert "non_existent_setting" not in filtered
    assert "another_missing" not in filtered
