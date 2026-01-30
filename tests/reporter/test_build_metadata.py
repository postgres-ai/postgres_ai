"""Tests for build metadata and initialization."""
import pytest
from unittest.mock import patch, MagicMock

from reporter.postgres_reports import PostgresReportGenerator


@pytest.mark.unit
def test_generator_initialization_with_prometheus_url_only() -> None:
    """Test initializing generator with only Prometheus URL."""
    generator = PostgresReportGenerator(prometheus_url="http://prometheus:9090")

    assert generator.prometheus_url == "http://prometheus:9090"
    # postgres_sink_url has a default value
    assert generator.postgres_sink_url is not None


@pytest.mark.unit
def test_generator_initialization_with_both_urls() -> None:
    """Test initializing generator with both URLs."""
    generator = PostgresReportGenerator(
        prometheus_url="http://prometheus:9090",
        postgres_sink_url="postgresql://user:pass@localhost:5432/metrics"
    )

    assert generator.prometheus_url == "http://prometheus:9090"
    assert generator.postgres_sink_url == "postgresql://user:pass@localhost:5432/metrics"


@pytest.mark.unit
def test_generator_has_build_metadata() -> None:
    """Test that generator has build metadata."""
    generator = PostgresReportGenerator(prometheus_url="http://prom.test")

    # Should have _build_metadata attribute
    assert hasattr(generator, '_build_metadata')
    assert isinstance(generator._build_metadata, dict)


@pytest.mark.unit
def test_generator_has_setting_constants() -> None:
    """Test that generator has setting name constants defined."""
    generator = PostgresReportGenerator(prometheus_url="http://prom.test")

    # Should have setting constants for different check types
    assert hasattr(generator, 'D004_SETTINGS')
    assert hasattr(generator, 'F001_SETTINGS')
    assert hasattr(generator, 'G001_SETTINGS')

    # Should be lists
    assert isinstance(generator.D004_SETTINGS, list)
    assert isinstance(generator.F001_SETTINGS, list)
    assert isinstance(generator.G001_SETTINGS, list)

    # Should contain expected settings
    assert "pg_stat_statements.max" in generator.D004_SETTINGS
    assert "autovacuum" in generator.F001_SETTINGS
    assert "shared_buffers" in generator.G001_SETTINGS


@pytest.mark.unit
def test_generator_pg_conn_initially_none() -> None:
    """Test that pg_conn is initially None."""
    generator = PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="postgresql://localhost/test"
    )

    # Should not auto-connect
    assert generator.pg_conn is None


@pytest.mark.unit
def test_multiple_generators_independent() -> None:
    """Test that multiple generator instances are independent."""
    gen1 = PostgresReportGenerator(prometheus_url="http://prom1.test")
    gen2 = PostgresReportGenerator(prometheus_url="http://prom2.test")

    assert gen1.prometheus_url != gen2.prometheus_url
    assert gen1 is not gen2
