"""Tests for generate_*_from_a003 methods."""
import pytest

from reporter.postgres_reports import PostgresReportGenerator


@pytest.fixture
def generator():
    """Create a generator instance for testing."""
    return PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
    )


@pytest.fixture
def sample_a003_report():
    """Sample A003 report for testing."""
    return {
        "check_id": "A003",
        "results": {
            "node-01": {
                "data": {
                    # D004 settings
                    "pg_stat_statements.max": {"setting": "5000"},
                    "pg_stat_statements.track": {"setting": "top"},
                    "shared_preload_libraries": {"setting": "pg_stat_statements"},
                    "track_io_timing": {"setting": "on"},

                    # F001 settings
                    "autovacuum": {"setting": "on"},
                    "autovacuum_max_workers": {"setting": "3"},
                    "autovacuum_naptime": {"setting": "60s"},

                    # G001 settings
                    "shared_buffers": {"setting": "128MB"},
                    "work_mem": {"setting": "4MB"},
                    "maintenance_work_mem": {"setting": "64MB"},
                    "effective_cache_size": {"setting": "4GB"},
                    "max_connections": {"setting": "100"},

                    # Version info
                    "server_version": {"setting": "14.10"},
                    "server_version_num": {"setting": "140010"},
                }
            }
        }
    }


@pytest.mark.unit
def test_generate_d004_from_a003(generator, sample_a003_report) -> None:
    """Test D004 report generation from A003."""
    report = generator.generate_d004_from_a003(
        sample_a003_report,
        cluster="test-cluster",
        node_name="node-01"
    )

    assert report["checkId"] == "D004"
    assert "results" in report
    assert "node-01" in report["results"]

    data = report["results"]["node-01"]["data"]
    # D004 wraps settings in a "settings" key
    assert "settings" in data
    settings = data["settings"]
    # Should contain D004 settings
    assert "pg_stat_statements.max" in settings
    assert "track_io_timing" in settings
    # Should NOT contain non-D004 settings
    assert "autovacuum" not in settings
    assert "shared_buffers" not in settings


@pytest.mark.unit
def test_generate_d004_from_a003_with_missing_settings(generator) -> None:
    """Test D004 generation when A003 has no relevant settings."""
    a003_report = {
        "check_id": "A003",
        "results": {
            "node-01": {
                "data": {
                    "shared_buffers": {"setting": "128MB"},
                    "work_mem": {"setting": "4MB"}
                    # No D004 settings
                }
            }
        }
    }

    report = generator.generate_d004_from_a003(a003_report, node_name="node-01")

    assert report["checkId"] == "D004"
    # Should have results but with empty/minimal data
    assert "results" in report


@pytest.mark.unit
def test_generate_f001_from_a003(generator, sample_a003_report) -> None:
    """Test F001 report generation from A003."""
    report = generator.generate_f001_from_a003(
        sample_a003_report,
        node_name="node-01"
    )

    assert report["checkId"] == "F001"
    assert "results" in report
    assert "node-01" in report["results"]

    data = report["results"]["node-01"]["data"]
    # Should contain F001 (autovacuum) settings
    assert "autovacuum" in data
    assert "autovacuum_max_workers" in data
    # Should NOT contain non-F001 settings
    assert "pg_stat_statements.max" not in data
    assert "shared_buffers" not in data


@pytest.mark.unit
def test_generate_f001_from_a003_with_missing_settings(generator) -> None:
    """Test F001 generation when A003 has no autovacuum settings."""
    a003_report = {
        "check_id": "A003",
        "results": {
            "node-01": {
                "data": {
                    "shared_buffers": {"setting": "128MB"}
                    # No F001 settings
                }
            }
        }
    }

    report = generator.generate_f001_from_a003(a003_report, node_name="node-01")

    assert report["checkId"] == "F001"
    assert "results" in report


@pytest.mark.unit
def test_generate_g001_from_a003(generator, sample_a003_report) -> None:
    """Test G001 report generation from A003."""
    report = generator.generate_g001_from_a003(
        sample_a003_report,
        node_name="node-01"
    )

    assert report["checkId"] == "G001"
    assert "results" in report
    assert "node-01" in report["results"]

    data = report["results"]["node-01"]["data"]
    # G001 wraps settings in a "settings" key and includes "analysis"
    assert "settings" in data
    assert "analysis" in data
    settings = data["settings"]
    # Should contain G001 (memory) settings
    assert "shared_buffers" in settings
    assert "work_mem" in settings
    assert "effective_cache_size" in settings
    # Should NOT contain non-G001 settings
    assert "pg_stat_statements.max" not in settings
    assert "autovacuum" not in settings


@pytest.mark.unit
def test_generate_g001_from_a003_with_partial_settings(generator) -> None:
    """Test G001 generation with only some memory settings."""
    a003_report = {
        "check_id": "A003",
        "results": {
            "node-01": {
                "data": {
                    "shared_buffers": {"setting": "128MB"},
                    "work_mem": {"setting": "4MB"},
                    # Missing other G001 settings
                    "autovacuum": {"setting": "on"}
                }
            }
        }
    }

    report = generator.generate_g001_from_a003(a003_report, node_name="node-01")

    assert report["checkId"] == "G001"
    data = report["results"]["node-01"]["data"]
    # G001 wraps settings in a "settings" key
    assert "settings" in data
    settings = data["settings"]
    # Should have the settings that exist
    assert "shared_buffers" in settings
    assert "work_mem" in settings
    # Should NOT have non-G001 settings
    assert "autovacuum" not in settings


@pytest.mark.unit
def test_generate_d004_from_a003_preserves_version_info(generator, sample_a003_report) -> None:
    """Test that D004 generation preserves PostgreSQL version info."""
    report = generator.generate_d004_from_a003(
        sample_a003_report,
        cluster="test-cluster",
        node_name="node-01"
    )

    # Version info should be preserved
    assert "postgres_version" in report["results"]["node-01"]
    version_info = report["results"]["node-01"]["postgres_version"]
    assert version_info["version"] == "14.10"
    assert version_info["server_major_ver"] == "14"


@pytest.mark.unit
def test_generate_from_a003_with_empty_results(generator) -> None:
    """Test generate_*_from_a003 methods handle empty A003 results."""
    empty_a003 = {
        "check_id": "A003",
        "results": {}
    }

    # All should handle empty results gracefully
    d004 = generator.generate_d004_from_a003(empty_a003)
    assert d004["checkId"] == "D004"

    f001 = generator.generate_f001_from_a003(empty_a003)
    assert f001["checkId"] == "F001"

    g001 = generator.generate_g001_from_a003(empty_a003)
    assert g001["checkId"] == "G001"


@pytest.mark.unit
def test_filter_a003_settings_with_d004_settings(generator, sample_a003_report) -> None:
    """Test filter_a003_settings extracts D004 settings correctly."""
    filtered = generator.filter_a003_settings(
        sample_a003_report,
        PostgresReportGenerator.D004_SETTINGS
    )

    # Should only have D004 settings
    assert "pg_stat_statements.max" in filtered
    assert "track_io_timing" in filtered
    assert "shared_preload_libraries" in filtered

    # Should NOT have other settings
    assert "autovacuum" not in filtered
    assert "shared_buffers" not in filtered


@pytest.mark.unit
def test_filter_a003_settings_with_f001_settings(generator, sample_a003_report) -> None:
    """Test filter_a003_settings extracts F001 settings correctly."""
    filtered = generator.filter_a003_settings(
        sample_a003_report,
        PostgresReportGenerator.F001_SETTINGS
    )

    # Should only have F001 settings
    assert "autovacuum" in filtered
    assert "autovacuum_max_workers" in filtered

    # Should NOT have other settings
    assert "pg_stat_statements.max" not in filtered
    assert "shared_buffers" not in filtered


@pytest.mark.unit
def test_filter_a003_settings_with_g001_settings(generator, sample_a003_report) -> None:
    """Test filter_a003_settings extracts G001 settings correctly."""
    filtered = generator.filter_a003_settings(
        sample_a003_report,
        PostgresReportGenerator.G001_SETTINGS
    )

    # Should only have G001 settings
    assert "shared_buffers" in filtered
    assert "work_mem" in filtered
    assert "effective_cache_size" in filtered

    # Should NOT have other settings
    assert "pg_stat_statements.max" not in filtered
    assert "autovacuum" not in filtered
