"""Unit tests for PostgreSQL Sink functionality."""
import pytest
from unittest.mock import Mock, patch, MagicMock

from reporter.postgres_reports import PostgresReportGenerator


@pytest.mark.unit
def test_connect_postgres_sink_without_psycopg2() -> None:
    """Test that connecting without psycopg2 raises RuntimeError."""
    generator = PostgresReportGenerator(
        prometheus_url="http://unused",
        postgres_sink_url="postgresql://user@host:5432/db",
    )

    with patch("reporter.postgres_reports.psycopg2", None):
        with pytest.raises(RuntimeError, match="psycopg2 is required"):
            generator.connect_postgres_sink()


@pytest.mark.unit
def test_connect_postgres_sink_connection_error() -> None:
    """Test connection error handling."""
    generator = PostgresReportGenerator(
        prometheus_url="http://unused",
        postgres_sink_url="postgresql://user@host:5432/db",
    )

    mock_psycopg2 = MagicMock()
    mock_psycopg2.connect.side_effect = Exception("Connection refused")

    with patch("reporter.postgres_reports.psycopg2", mock_psycopg2):
        result = generator.connect_postgres_sink()
        assert result is False
        assert generator.pg_conn is None


@pytest.mark.unit
def test_get_index_definitions_auto_connects() -> None:
    """Test that get_index_definitions_from_sink auto-connects if needed."""
    generator = PostgresReportGenerator(
        prometheus_url="http://unused",
        postgres_sink_url="postgresql://user@host:5432/db",
    )

    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_cursor.__enter__ = Mock(return_value=mock_cursor)
    mock_cursor.__exit__ = Mock(return_value=False)
    mock_cursor.__iter__ = Mock(return_value=iter([]))
    mock_conn.cursor.return_value = mock_cursor

    mock_psycopg2 = MagicMock()
    mock_psycopg2.connect.return_value = mock_conn
    mock_psycopg2.extras.DictCursor = MagicMock()

    with patch("reporter.postgres_reports.psycopg2", mock_psycopg2):
        definitions = generator.get_index_definitions_from_sink()

        # Should have tried to connect
        mock_psycopg2.connect.assert_called_once()
        assert definitions == {}


@pytest.mark.unit
def test_get_index_definitions_handles_query_error() -> None:
    """Test that get_index_definitions_from_sink handles query errors gracefully."""
    generator = PostgresReportGenerator(
        prometheus_url="http://unused",
        postgres_sink_url="postgresql://user@host:5432/db",
    )

    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_cursor.__enter__ = Mock(return_value=mock_cursor)
    mock_cursor.__exit__ = Mock(return_value=False)
    mock_cursor.execute.side_effect = Exception("Query failed")
    mock_conn.cursor.return_value = mock_cursor

    generator.pg_conn = mock_conn

    mock_psycopg2 = MagicMock()
    mock_psycopg2.extras.DictCursor = MagicMock()

    with patch("reporter.postgres_reports.psycopg2", mock_psycopg2):
        definitions = generator.get_index_definitions_from_sink()

        # Should return empty dict on error
        assert definitions == {}


@pytest.mark.unit
def test_get_queryid_queries_auto_connects() -> None:
    """Test that get_queryid_queries_from_sink auto-connects if needed."""
    generator = PostgresReportGenerator(
        prometheus_url="http://unused",
        postgres_sink_url="postgresql://user@host:5432/db",
    )

    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_cursor.__enter__ = Mock(return_value=mock_cursor)
    mock_cursor.__exit__ = Mock(return_value=False)
    mock_cursor.__iter__ = Mock(return_value=iter([]))
    mock_conn.cursor.return_value = mock_cursor

    mock_psycopg2 = MagicMock()
    mock_psycopg2.connect.return_value = mock_conn
    mock_psycopg2.extras.DictCursor = MagicMock()

    with patch("reporter.postgres_reports.psycopg2", mock_psycopg2):
        queries = generator.get_queryid_queries_from_sink()

        # Should have tried to connect
        mock_psycopg2.connect.assert_called_once()
        assert queries == {}


@pytest.mark.unit
def test_get_queryid_queries_handles_query_error() -> None:
    """Test that get_queryid_queries_from_sink handles query errors gracefully."""
    generator = PostgresReportGenerator(
        prometheus_url="http://unused",
        postgres_sink_url="postgresql://user@host:5432/db",
    )

    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_cursor.__enter__ = Mock(return_value=mock_cursor)
    mock_cursor.__exit__ = Mock(return_value=False)
    mock_cursor.execute.side_effect = Exception("Query failed")
    mock_conn.cursor.return_value = mock_cursor

    generator.pg_conn = mock_conn

    mock_psycopg2 = MagicMock()
    mock_psycopg2.extras.DictCursor = MagicMock()

    with patch("reporter.postgres_reports.psycopg2", mock_psycopg2):
        queries = generator.get_queryid_queries_from_sink()

        # Should return empty dict on error
        assert queries == {}


@pytest.mark.unit
def test_close_postgres_sink_with_connection() -> None:
    """Test closing connection when connected."""
    generator = PostgresReportGenerator(
        prometheus_url="http://unused",
        postgres_sink_url="postgresql://user@host:5432/db",
    )

    mock_conn = MagicMock()
    generator.pg_conn = mock_conn

    generator.close_postgres_sink()

    mock_conn.close.assert_called_once()
    assert generator.pg_conn is None


@pytest.mark.unit
def test_close_postgres_sink_without_connection() -> None:
    """Test closing when not connected doesn't crash."""
    generator = PostgresReportGenerator(
        prometheus_url="http://unused",
        postgres_sink_url="postgresql://user@host:5432/db",
    )

    generator.pg_conn = None

    # Should not raise
    generator.close_postgres_sink()
    assert generator.pg_conn is None
