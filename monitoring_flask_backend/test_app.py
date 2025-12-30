"""Tests for the Flask monitoring backend."""
import pytest
import json
from unittest.mock import patch, mock_open

from app import app, read_version_file


@pytest.fixture
def client():
    """Create test client."""
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


class TestVersionEndpoint:
    """Tests for the /version endpoint."""

    def test_version_endpoint_returns_json(self, client):
        """Test that /version returns valid JSON."""
        response = client.get('/version')
        assert response.status_code == 200
        assert response.content_type == 'application/json'

    def test_version_endpoint_returns_array(self, client):
        """Test that /version returns array for Grafana Infinity datasource."""
        response = client.get('/version')
        data = json.loads(response.data)
        assert isinstance(data, list)
        assert len(data) == 1

    def test_version_endpoint_contains_version_field(self, client):
        """Test that /version response contains version field."""
        response = client.get('/version')
        data = json.loads(response.data)
        assert 'version' in data[0]

    def test_version_endpoint_contains_build_ts_field(self, client):
        """Test that /version response contains build_ts field."""
        response = client.get('/version')
        data = json.loads(response.data)
        assert 'build_ts' in data[0]


class TestReadVersionFile:
    """Tests for the read_version_file function."""

    def test_read_version_file_success(self):
        """Test reading version file successfully."""
        mock_content = "1.2.3"
        with patch("builtins.open", mock_open(read_data=mock_content)):
            result = read_version_file("/VERSION")
            assert result == "1.2.3"

    def test_read_version_file_strips_whitespace(self):
        """Test that version file content is stripped."""
        mock_content = "  1.2.3\n  "
        with patch("builtins.open", mock_open(read_data=mock_content)):
            result = read_version_file("/VERSION")
            assert result == "1.2.3"

    def test_read_version_file_not_found_returns_default(self):
        """Test that missing file returns default value."""
        with patch("builtins.open", side_effect=FileNotFoundError()):
            result = read_version_file("/VERSION")
            assert result == "unknown"

    def test_read_version_file_custom_default(self):
        """Test custom default value when file not found."""
        with patch("builtins.open", side_effect=FileNotFoundError()):
            result = read_version_file("/VERSION", default="0.0.0")
            assert result == "0.0.0"


class TestHealthEndpoint:
    """Tests for the /health endpoint."""

    @patch('app.get_prometheus_client')
    def test_health_endpoint_healthy(self, mock_prom, client):
        """Test /health returns healthy when Prometheus is reachable."""
        mock_prom.return_value.get_current_metric_value.return_value = [{'value': 1}]
        response = client.get('/health')
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data['status'] == 'healthy'

    @patch('app.get_prometheus_client')
    def test_health_endpoint_unhealthy(self, mock_prom, client):
        """Test /health returns unhealthy when Prometheus is unreachable."""
        mock_prom.return_value.get_current_metric_value.side_effect = Exception("Connection failed")
        response = client.get('/health')
        assert response.status_code == 500
        data = json.loads(response.data)
        assert data['status'] == 'unhealthy'
