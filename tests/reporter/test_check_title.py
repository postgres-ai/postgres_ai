"""Tests for get_check_title and related helper methods."""
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
def test_get_check_title_for_known_checks(generator) -> None:
    """Test getting titles for known check IDs."""
    # These should return descriptive titles
    assert "version" in generator.get_check_title("A002").lower()
    assert "settings" in generator.get_check_title("A003").lower()
    assert "unused" in generator.get_check_title("H002").lower()
    assert "redundant" in generator.get_check_title("H004").lower()
    assert "bloat" in generator.get_check_title("F004").lower()
    assert "memory" in generator.get_check_title("G001").lower()
    assert "stat" in generator.get_check_title("D004").lower()


@pytest.mark.unit
def test_get_check_title_for_query_checks(generator) -> None:
    """Test getting titles for query-related check IDs."""
    # Check that titles are non-empty and descriptive
    k001_title = generator.get_check_title("K001").lower()
    assert "query" in k001_title or "metric" in k001_title or "k001" in k001_title

    k003_title = generator.get_check_title("K003").lower()
    assert "query" in k003_title or "top" in k003_title or "k003" in k003_title

    k004_title = generator.get_check_title("K004").lower()
    assert "temp" in k004_title or "k004" in k004_title

    k005_title = generator.get_check_title("K005").lower()
    assert "wal" in k005_title or "k005" in k005_title


@pytest.mark.unit
def test_get_check_title_for_mean_checks(generator) -> None:
    """Test getting titles for mean time check IDs."""
    m001_title = generator.get_check_title("M001").lower()
    assert "mean" in m001_title or "time" in m001_title or "m001" in m001_title

    m002_title = generator.get_check_title("M002").lower()
    assert "rows" in m002_title or "m002" in m002_title

    m003_title = generator.get_check_title("M003").lower()
    assert "i/o" in m003_title or "io" in m003_title or "m003" in m003_title


@pytest.mark.unit
def test_get_check_title_for_unknown_check(generator) -> None:
    """Test getting title for unknown check ID."""
    # Unknown check IDs should return a default or the check ID itself
    result = generator.get_check_title("Z999")
    assert "Z999" in result or "Unknown" in result or result == ""


@pytest.mark.unit
def test_get_check_title_for_autovacuum_checks(generator) -> None:
    """Test getting titles for autovacuum-related checks."""
    assert "Autovacuum" in generator.get_check_title("F001")
    assert "Autovacuum" in generator.get_check_title("F004") or "Bloat" in generator.get_check_title("F004")


@pytest.mark.unit
def test_get_check_title_for_cluster_checks(generator) -> None:
    """Test getting titles for cluster-related checks."""
    assert "Cluster" in generator.get_check_title("A004")


@pytest.mark.unit
def test_get_check_title_for_wait_events(generator) -> None:
    """Test getting title for wait events check."""
    result = generator.get_check_title("N001")
    assert "Wait" in result or "Events" in result or "N001" in result
