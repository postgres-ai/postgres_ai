"""Tests for format_setting_value method."""
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
def test_format_setting_value_with_ms_unit(generator) -> None:
    """Test formatting values with milliseconds unit."""
    # Values >= 1000 and divisible by 1000 are converted to seconds
    assert generator.format_setting_value("work_mem", "1000", "ms") == "1 s"
    assert generator.format_setting_value("work_mem", "5000", "ms") == "5 s"
    # Values < 1000 or not divisible by 1000 remain in ms
    assert generator.format_setting_value("work_mem", "500", "ms") == "500 ms"
    assert generator.format_setting_value("work_mem", "1500", "ms") == "1500 ms"


@pytest.mark.unit
def test_format_setting_value_with_s_unit(generator) -> None:
    """Test formatting values with seconds unit."""
    assert generator.format_setting_value("statement_timeout", "30", "s") == "30 s"
    assert generator.format_setting_value("lock_timeout", "10", "s") == "10 s"


@pytest.mark.unit
def test_format_setting_value_with_min_unit(generator) -> None:
    """Test formatting values with minutes unit."""
    assert generator.format_setting_value("autovacuum_naptime", "1", "min") == "1 min"
    assert generator.format_setting_value("checkpoint_timeout", "5", "min") == "5 min"


@pytest.mark.unit
def test_format_setting_value_with_connections_unit(generator) -> None:
    """Test formatting values with connections unit."""
    assert generator.format_setting_value("max_connections", "100", "connections") == "100 connections"
    assert generator.format_setting_value("superuser_reserved_connections", "3", "connections") == "3 connections"


@pytest.mark.unit
def test_format_setting_value_with_workers_unit(generator) -> None:
    """Test formatting values with workers unit."""
    assert generator.format_setting_value("max_worker_processes", "8", "workers") == "8 workers"
    assert generator.format_setting_value("max_parallel_workers", "4", "workers") == "4 workers"


@pytest.mark.unit
def test_format_setting_value_with_custom_unit(generator) -> None:
    """Test formatting values with arbitrary custom units."""
    assert generator.format_setting_value("some_setting", "42", "custom_unit") == "42 custom_unit"


@pytest.mark.unit
def test_format_setting_value_with_memory_settings(generator) -> None:
    """Test formatting memory-related settings."""
    # These use the fallback logic based on setting name
    result = generator.format_setting_value("shared_buffers", "131072", "8kB")
    assert "GiB" in result or "GB" in result or "MiB" in result or "MB" in result


@pytest.mark.unit
def test_format_setting_value_with_work_mem(generator) -> None:
    """Test formatting work_mem setting."""
    result = generator.format_setting_value("work_mem", "4096", "kB")
    assert "MiB" in result or "MB" in result or "KiB" in result or "kB" in result


@pytest.mark.unit
def test_format_setting_value_with_8kb_unit(generator) -> None:
    """Test formatting values with 8kB unit (PostgreSQL block size)."""
    # Value is multiplied by 8 first (8kB blocks), then converted if >= 1024 KiB
    # 1024 blocks * 8 = 8192 KiB = 8 MiB
    assert generator.format_setting_value("shared_buffers", "1024", "8kB") == "8 MiB"
    # 128 blocks * 8 = 1024 KiB = 1 MiB
    assert generator.format_setting_value("shared_buffers", "128", "8kB") == "1 MiB"
    # 100 blocks * 8 = 800 KiB (< 1024, stays in KiB)
    assert generator.format_setting_value("shared_buffers", "100", "8kB") == "800 KiB"
    # 127 blocks * 8 = 1016 KiB (< 1024, stays in KiB)
    assert generator.format_setting_value("shared_buffers", "127", "8kB") == "1016 KiB"


@pytest.mark.unit
def test_format_setting_value_with_no_unit(generator) -> None:
    """Test formatting values without unit."""
    # When no unit is provided, the method handles it based on setting name
    result = generator.format_setting_value("max_connections", "100", "")
    assert "100" in result
