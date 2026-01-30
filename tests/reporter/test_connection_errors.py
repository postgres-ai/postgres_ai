"""Tests for connection error handling."""
import pytest
from unittest.mock import Mock, patch, MagicMock
import requests

from reporter.postgres_reports import PostgresReportGenerator


@pytest.mark.unit
def test_connection_success() -> None:
    """Test successful Prometheus connection."""
    generator = PostgresReportGenerator(prometheus_url="http://prom.test")

    mock_response = Mock()
    mock_response.status_code = 200

    with patch("reporter.postgres_reports.requests.get", return_value=mock_response):
        result = generator.test_connection()
        assert result is True


@pytest.mark.unit
def test_connection_http_error() -> None:
    """Test connection with HTTP error status."""
    generator = PostgresReportGenerator(prometheus_url="http://prom.test")

    mock_response = Mock()
    mock_response.status_code = 500

    with patch("reporter.postgres_reports.requests.get", return_value=mock_response):
        result = generator.test_connection()
        assert result is False


@pytest.mark.unit
def test_connection_timeout() -> None:
    """Test connection timeout handling."""
    generator = PostgresReportGenerator(prometheus_url="http://prom.test")

    with patch("reporter.postgres_reports.requests.get", side_effect=requests.Timeout("Connection timed out")):
        result = generator.test_connection()
        assert result is False


@pytest.mark.unit
def test_connection_network_error() -> None:
    """Test network error handling."""
    generator = PostgresReportGenerator(prometheus_url="http://prom.test")

    with patch("reporter.postgres_reports.requests.get",
               side_effect=requests.ConnectionError("Network unreachable")):
        result = generator.test_connection()
        assert result is False


@pytest.mark.unit
def test_connection_generic_exception() -> None:
    """Test generic exception handling."""
    generator = PostgresReportGenerator(prometheus_url="http://prom.test")

    with patch("reporter.postgres_reports.requests.get",
               side_effect=Exception("Something went wrong")):
        result = generator.test_connection()
        assert result is False


@pytest.mark.unit
def test_connection_with_amp_authentication() -> None:
    """Test connection with AWS AMP authentication."""
    with patch.dict("os.environ", {"ENABLE_AMP": "true", "AWS_REGION": "us-west-2"}):
        # Mock boto3 session
        mock_session = MagicMock()
        mock_credentials = MagicMock()
        mock_credentials.access_key = "test-key"
        mock_credentials.secret_key = "test-secret"
        mock_credentials.token = "test-token"
        mock_session.get_credentials.return_value = mock_credentials

        with patch("reporter.postgres_reports.boto3.Session", return_value=mock_session):
            generator = PostgresReportGenerator(prometheus_url="http://prom.test")

            # Generator should have auth configured
            assert generator.auth is not None

            mock_response = Mock()
            mock_response.status_code = 200

            with patch("reporter.postgres_reports.requests.get", return_value=mock_response) as mock_get:
                result = generator.test_connection()
                assert result is True
                # Verify auth was passed to requests
                mock_get.assert_called_once()
                call_kwargs = mock_get.call_args[1]
                assert "auth" in call_kwargs
                assert call_kwargs["auth"] == generator.auth


@pytest.mark.unit
def test_connection_amp_authentication_failure() -> None:
    """Test AMP authentication failure."""
    with patch.dict("os.environ", {"ENABLE_AMP": "true", "AWS_REGION": "us-west-2"}):
        # Mock boto3 session that fails to get credentials
        mock_session = MagicMock()
        mock_session.get_credentials.return_value = None

        with patch("reporter.postgres_reports.boto3.Session", return_value=mock_session):
            generator = PostgresReportGenerator(prometheus_url="http://prom.test")

            # Should handle missing credentials gracefully
            assert generator.auth is None


@pytest.mark.unit
def test_connection_amp_disabled_by_default() -> None:
    """Test that AMP is disabled by default."""
    # Ensure ENABLE_AMP is not set
    with patch.dict("os.environ", {}, clear=True):
        generator = PostgresReportGenerator(prometheus_url="http://prom.test")

        # Should not have auth configured
        assert generator.auth is None


@pytest.mark.unit
def test_connection_amp_with_invalid_region() -> None:
    """Test AMP with invalid AWS region."""
    with patch.dict("os.environ", {"ENABLE_AMP": "true", "AWS_REGION": "invalid-region"}):
        # Mock boto3.Session to raise exception
        with patch("reporter.postgres_reports.boto3.Session", side_effect=Exception("Invalid region")):
            # Should crash since boto3.Session initialization fails
            # This is expected behavior - invalid AWS config should fail fast
            with pytest.raises(Exception, match="Invalid region"):
                generator = PostgresReportGenerator(prometheus_url="http://prom.test")


@pytest.mark.unit
def test_connection_with_custom_timeout() -> None:
    """Test that connection uses correct timeout."""
    generator = PostgresReportGenerator(prometheus_url="http://prom.test")

    mock_response = Mock()
    mock_response.status_code = 200

    with patch("reporter.postgres_reports.requests.get", return_value=mock_response) as mock_get:
        generator.test_connection()

        # Verify timeout is set
        call_kwargs = mock_get.call_args[1]
        assert "timeout" in call_kwargs
        assert call_kwargs["timeout"] == 10
