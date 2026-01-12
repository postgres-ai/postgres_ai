"""Tests for AWS Managed Prometheus (AMP) authentication in PostgresReportGenerator."""

import pytest
from unittest.mock import MagicMock, patch

from reporter import postgres_reports as postgres_reports_module


class TestReporterAMPAuthentication:
    """Tests for AMP authentication in PostgresReportGenerator."""

    def test_amp_disabled_by_default(self, monkeypatch):
        """Test that auth is None when ENABLE_AMP is not set."""
        monkeypatch.delenv('ENABLE_AMP', raising=False)

        with patch.object(postgres_reports_module, 'boto3') as mock_boto3:
            generator = postgres_reports_module.PostgresReportGenerator(
                prometheus_url="http://prom.test",
                postgres_sink_url="",
            )

            assert generator.auth is None
            mock_boto3.Session.assert_not_called()

    def test_amp_enabled_creates_aws4auth(self, monkeypatch):
        """Test that enabling AMP creates AWS4Auth with refreshable credentials."""
        monkeypatch.setenv('ENABLE_AMP', 'true')
        monkeypatch.setenv('AWS_REGION', 'eu-west-1')

        mock_credentials = MagicMock()
        mock_session = MagicMock()
        mock_session.get_credentials.return_value = mock_credentials
        mock_auth = MagicMock()

        with patch.object(postgres_reports_module, 'boto3') as mock_boto3, \
             patch.object(postgres_reports_module, 'AWS4Auth', return_value=mock_auth) as mock_aws4auth:
            mock_boto3.Session.return_value = mock_session

            generator = postgres_reports_module.PostgresReportGenerator(
                prometheus_url="http://prom.test",
                postgres_sink_url="",
            )

            # Verify AWS4Auth was created with correct params
            mock_aws4auth.assert_called_once_with(
                region='eu-west-1',
                service='aps',
                refreshable_credentials=mock_credentials,
            )
            assert generator.auth is mock_auth

    def test_amp_enabled_no_credentials(self, monkeypatch):
        """Test that auth remains None when credentials unavailable."""
        monkeypatch.setenv('ENABLE_AMP', 'true')

        mock_session = MagicMock()
        mock_session.get_credentials.return_value = None

        with patch.object(postgres_reports_module, 'boto3') as mock_boto3, \
             patch.object(postgres_reports_module, 'AWS4Auth') as mock_aws4auth:
            mock_boto3.Session.return_value = mock_session

            generator = postgres_reports_module.PostgresReportGenerator(
                prometheus_url="http://prom.test",
                postgres_sink_url="",
            )

            mock_aws4auth.assert_not_called()
            assert generator.auth is None

    def test_amp_auth_passed_to_requests(self, monkeypatch):
        """Test that auth is passed to requests.get calls."""
        monkeypatch.setenv('ENABLE_AMP', 'true')

        mock_credentials = MagicMock()
        mock_session = MagicMock()
        mock_session.get_credentials.return_value = mock_credentials
        mock_auth = MagicMock()

        captured_kwargs = {}

        class DummyResponse:
            status_code = 200

        def fake_get(url, **kwargs):
            captured_kwargs.update(kwargs)
            return DummyResponse()

        with patch.object(postgres_reports_module, 'boto3') as mock_boto3, \
             patch.object(postgres_reports_module, 'AWS4Auth', return_value=mock_auth), \
             patch.object(postgres_reports_module.requests, 'get', fake_get):
            mock_boto3.Session.return_value = mock_session

            generator = postgres_reports_module.PostgresReportGenerator(
                prometheus_url="http://prom.test",
                postgres_sink_url="",
            )

            # Call test_connection which uses requests.get with auth
            generator.test_connection()

            # Verify auth was passed to requests.get
            assert captured_kwargs.get('auth') is mock_auth

    def test_amp_default_region(self, monkeypatch):
        """Test that default region is us-east-1."""
        monkeypatch.setenv('ENABLE_AMP', 'true')
        monkeypatch.delenv('AWS_REGION', raising=False)

        mock_credentials = MagicMock()
        mock_session = MagicMock()
        mock_session.get_credentials.return_value = mock_credentials

        with patch.object(postgres_reports_module, 'boto3') as mock_boto3, \
             patch.object(postgres_reports_module, 'AWS4Auth') as mock_aws4auth:
            mock_boto3.Session.return_value = mock_session

            generator = postgres_reports_module.PostgresReportGenerator(
                prometheus_url="http://prom.test",
                postgres_sink_url="",
            )

            call_kwargs = mock_aws4auth.call_args[1]
            assert call_kwargs['region'] == 'us-east-1'
