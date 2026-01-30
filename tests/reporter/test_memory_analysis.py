"""Tests for memory analysis methods."""
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
def test_analyze_memory_settings_with_complete_data(generator) -> None:
    """Test memory analysis with complete memory settings."""
    memory_data = {
        "shared_buffers": {"setting": "1GB"},
        "work_mem": {"setting": "4MB"},
        "maintenance_work_mem": {"setting": "64MB"},
        "effective_cache_size": {"setting": "4GB"},
        "max_connections": {"setting": "100"},
        "wal_buffers": {"setting": "16MB"},
    }

    analysis = generator._analyze_memory_settings(memory_data)

    assert "estimated_total_memory_usage" in analysis
    estimates = analysis["estimated_total_memory_usage"]
    assert "shared_buffers_bytes" in estimates
    assert "work_mem_per_connection_bytes" in estimates
    assert "maintenance_work_mem_bytes" in estimates
    assert "effective_cache_size_bytes" in estimates
    assert estimates["shared_buffers_bytes"] == 1024 * 1024 * 1024  # 1GB


@pytest.mark.unit
def test_analyze_memory_settings_with_missing_values(generator) -> None:
    """Test memory analysis when some settings are missing."""
    memory_data = {
        "shared_buffers": {"setting": "128MB"},
        # Missing work_mem and others - should use defaults
    }

    analysis = generator._analyze_memory_settings(memory_data)

    assert "estimated_total_memory_usage" in analysis
    estimates = analysis["estimated_total_memory_usage"]
    # Should have calculated values even with missing settings
    assert "shared_buffers_bytes" in estimates


@pytest.mark.unit
def test_analyze_memory_settings_with_empty_data(generator) -> None:
    """Test memory analysis with empty memory data."""
    memory_data = {}

    analysis = generator._analyze_memory_settings(memory_data)

    assert "estimated_total_memory_usage" in analysis
    # Should still have estimates based on defaults


@pytest.mark.unit
def test_analyze_memory_settings_with_large_values(generator) -> None:
    """Test memory analysis with large memory values."""
    memory_data = {
        "shared_buffers": {"setting": "32GB"},
        "work_mem": {"setting": "128MB"},
        "maintenance_work_mem": {"setting": "2GB"},
        "effective_cache_size": {"setting": "96GB"},
        "max_connections": {"setting": "500"},
    }

    analysis = generator._analyze_memory_settings(memory_data)

    estimates = analysis["estimated_total_memory_usage"]
    assert estimates["shared_buffers_bytes"] == 32 * 1024 * 1024 * 1024  # 32GB
    # Check work_mem calculations reflect the high connection count
    assert "max_work_mem_usage_bytes" in estimates
    assert estimates["max_work_mem_usage_bytes"] > 0


@pytest.mark.unit
def test_analyze_memory_settings_with_invalid_values(generator) -> None:
    """Test memory analysis handles invalid values gracefully."""
    memory_data = {
        "shared_buffers": {"setting": "invalid"},
        "work_mem": {"setting": "4MB"},
        "max_connections": {"setting": "not_a_number"},
    }

    # Should not raise exception, should use defaults or 0
    analysis = generator._analyze_memory_settings(memory_data)
    assert "estimated_total_memory_usage" in analysis
