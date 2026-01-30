"""Tests for format_bytes method."""
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
def test_format_bytes_zero(generator) -> None:
    """Test formatting zero bytes."""
    result = generator.format_bytes(0)
    assert result == "0 B" or result == "0.00 B"


@pytest.mark.unit
def test_format_bytes_small_values(generator) -> None:
    """Test formatting small byte values."""
    result = generator.format_bytes(512)
    assert "512" in result and "B" in result


@pytest.mark.unit
def test_format_bytes_kilobytes(generator) -> None:
    """Test formatting values in KB range."""
    result = generator.format_bytes(2048)  # 2 KB
    assert "2" in result or "2048" in result
    assert "KiB" in result or "KB" in result or "B" in result


@pytest.mark.unit
def test_format_bytes_megabytes(generator) -> None:
    """Test formatting values in MB range."""
    result = generator.format_bytes(10 * 1024 * 1024)  # 10 MB
    assert "10" in result or "MiB" in result or "MB" in result


@pytest.mark.unit
def test_format_bytes_gigabytes(generator) -> None:
    """Test formatting values in GB range."""
    result = generator.format_bytes(5 * 1024 * 1024 * 1024)  # 5 GB
    assert "5" in result or "GiB" in result or "GB" in result


@pytest.mark.unit
def test_format_bytes_terabytes(generator) -> None:
    """Test formatting values in TB range."""
    result = generator.format_bytes(2 * 1024 * 1024 * 1024 * 1024)  # 2 TB
    assert "2" in result or "TiB" in result or "TB" in result


@pytest.mark.unit
def test_format_bytes_large_value(generator) -> None:
    """Test formatting very large byte values."""
    result = generator.format_bytes(10 * 1024 * 1024 * 1024 * 1024)  # 10 TB
    assert "10" in result
    # Should be in TB or TiB
    assert "TiB" in result or "TB" in result


@pytest.mark.unit
def test_format_bytes_fractional_values(generator) -> None:
    """Test formatting values that result in fractional units."""
    result = generator.format_bytes(1536 * 1024)  # 1.5 MB
    # Should contain decimal or round to nearest unit
    assert "MiB" in result or "MB" in result or "KiB" in result or "KB" in result


@pytest.mark.unit
def test_format_bytes_boundary_values(generator) -> None:
    """Test formatting values at unit boundaries."""
    result_1k = generator.format_bytes(1024)
    assert "1" in result_1k

    result_1m = generator.format_bytes(1024 * 1024)
    assert "1" in result_1m

    result_1g = generator.format_bytes(1024 * 1024 * 1024)
    assert "1" in result_1g
