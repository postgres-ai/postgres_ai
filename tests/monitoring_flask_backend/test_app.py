"""
Unit tests for the monitoring Flask backend.
"""
import pytest
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime, timezone, timedelta
import json
import io
import csv

# Import the app module
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from monitoring_flask_backend import app as flask_app


@pytest.fixture
def app():
    """Create Flask test client."""
    flask_app.app.config['TESTING'] = True
    return flask_app.app


@pytest.fixture
def client(app):
    """Create test client."""
    return app.test_client()


class TestHealthEndpoint:
    """Tests for /health endpoint."""

    def test_health_returns_healthy_when_prometheus_available(self, client):
        """Test health endpoint returns healthy status."""
        mock_prom = Mock()
        mock_prom.get_current_metric_value.return_value = [{'metric': {}, 'value': [0, '1']}]

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/health')
            assert response.status_code == 200
            data = json.loads(response.data)
            assert data['status'] == 'healthy'
            assert 'prometheus_url' in data

    def test_health_returns_unhealthy_on_prometheus_error(self, client):
        """Test health endpoint returns unhealthy when Prometheus fails."""
        mock_prom = Mock()
        mock_prom.get_current_metric_value.side_effect = Exception("Connection refused")

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/health')
            assert response.status_code == 500
            data = json.loads(response.data)
            assert data['status'] == 'unhealthy'
            assert 'error' in data


class TestGetPrometheusClient:
    """Tests for get_prometheus_client function."""

    def test_get_prometheus_client_success(self):
        """Test successful Prometheus client creation."""
        with patch('monitoring_flask_backend.app.PrometheusConnect') as mock_class:
            mock_instance = Mock()
            mock_class.return_value = mock_instance

            result = flask_app.get_prometheus_client()
            assert result == mock_instance
            mock_class.assert_called_once()

    def test_get_prometheus_client_failure(self):
        """Test Prometheus client creation failure."""
        with patch('monitoring_flask_backend.app.PrometheusConnect') as mock_class:
            mock_class.side_effect = Exception("Connection failed")

            with pytest.raises(Exception, match="Connection failed"):
                flask_app.get_prometheus_client()


class TestPgssMetricsEndpoint:
    """Tests for /pgss_metrics/csv endpoint."""

    def test_pgss_metrics_missing_time_params(self, client):
        """Test PGSS metrics returns error without time parameters."""
        response = client.get('/pgss_metrics/csv')
        assert response.status_code == 400
        data = json.loads(response.data)
        assert 'error' in data

    def test_pgss_metrics_missing_time_end(self, client):
        """Test PGSS metrics returns error without time_end."""
        response = client.get('/pgss_metrics/csv?time_start=1704067200')
        assert response.status_code == 400

    def test_pgss_metrics_success_with_unix_timestamps(self, client):
        """Test PGSS metrics with Unix timestamps."""
        mock_prom = Mock()
        # Return empty data
        mock_prom.get_metric_range_data.return_value = []

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/pgss_metrics/csv?time_start=1704067200&time_end=1704153600')
            assert response.status_code == 200
            assert 'text/csv' in response.content_type

    def test_pgss_metrics_success_with_iso_timestamps(self, client):
        """Test PGSS metrics with ISO format timestamps."""
        mock_prom = Mock()
        mock_prom.get_metric_range_data.return_value = []

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/pgss_metrics/csv?time_start=2024-01-01T00:00:00Z&time_end=2024-01-02T00:00:00Z')
            assert response.status_code == 200

    def test_pgss_metrics_with_filters(self, client):
        """Test PGSS metrics with cluster/node/db filters."""
        mock_prom = Mock()
        mock_prom.get_metric_range_data.return_value = []

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get(
                '/pgss_metrics/csv?time_start=1704067200&time_end=1704153600'
                '&cluster_name=test_cluster&node_name=node1&db_name=testdb'
            )
            assert response.status_code == 200

    def test_pgss_metrics_with_data(self, client):
        """Test PGSS metrics with actual metric data."""
        mock_prom = Mock()

        # Mock metric data
        start_ts = 1704067200
        end_ts = 1704153600

        def mock_range_data(metric_name, start_time, end_time):
            if 'calls' in metric_name:
                return [{
                    'metric': {
                        '__name__': 'pgwatch_pg_stat_statements_calls',
                        'datname': 'testdb',
                        'queryid': '12345',
                        'user': 'postgres',
                        'instance': 'localhost:5432'
                    },
                    'values': [[start_ts, '100'], [end_ts, '200']]
                }]
            return []

        mock_prom.get_metric_range_data.side_effect = mock_range_data

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get(f'/pgss_metrics/csv?time_start={start_ts}&time_end={end_ts}')
            assert response.status_code == 200
            assert 'text/csv' in response.content_type

    def test_pgss_metrics_handles_query_errors(self, client):
        """Test PGSS metrics handles query errors gracefully."""
        mock_prom = Mock()
        mock_prom.get_metric_range_data.side_effect = Exception("Query failed")

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/pgss_metrics/csv?time_start=1704067200&time_end=1704153600')
            # Should return empty CSV, not error (graceful handling)
            assert response.status_code == 200


class TestBtreeBloatEndpoint:
    """Tests for /btree_bloat/csv endpoint."""

    def test_btree_bloat_success_no_filters(self, client):
        """Test btree bloat endpoint without filters."""
        mock_prom = Mock()
        mock_prom.custom_query.return_value = []

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/btree_bloat/csv')
            assert response.status_code == 200
            assert 'text/csv' in response.content_type

    def test_btree_bloat_with_all_filters(self, client):
        """Test btree bloat endpoint with all filters."""
        mock_prom = Mock()
        mock_prom.custom_query.return_value = []

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get(
                '/btree_bloat/csv?cluster_name=c1&node_name=n1&db_name=db1'
                '&schemaname=public&tblname=users&idxname=users_pkey'
            )
            assert response.status_code == 200

    def test_btree_bloat_with_data(self, client):
        """Test btree bloat endpoint with actual data."""
        mock_prom = Mock()

        def mock_query(query):
            if 'real_size_mib' in query:
                return [{
                    'metric': {
                        'datname': 'testdb',
                        'schemaname': 'public',
                        'tblname': 'users',
                        'idxname': 'users_pkey'
                    },
                    'value': [1704067200, '10.5']
                }]
            elif 'extra_size' in query and 'extra_pct' not in query:
                return [{
                    'metric': {
                        'datname': 'testdb',
                        'schemaname': 'public',
                        'tblname': 'users',
                        'idxname': 'users_pkey'
                    },
                    'value': [1704067200, '1048576']
                }]
            elif 'extra_pct' in query:
                return [{
                    'metric': {
                        'datname': 'testdb',
                        'schemaname': 'public',
                        'tblname': 'users',
                        'idxname': 'users_pkey'
                    },
                    'value': [1704067200, '5.2']
                }]
            elif 'fillfactor' in query:
                return [{
                    'metric': {
                        'datname': 'testdb',
                        'schemaname': 'public',
                        'tblname': 'users',
                        'idxname': 'users_pkey'
                    },
                    'value': [1704067200, '90']
                }]
            elif 'bloat_size' in query:
                return [{
                    'metric': {
                        'datname': 'testdb',
                        'schemaname': 'public',
                        'tblname': 'users',
                        'idxname': 'users_pkey'
                    },
                    'value': [1704067200, '524288']
                }]
            elif 'bloat_pct' in query:
                return [{
                    'metric': {
                        'datname': 'testdb',
                        'schemaname': 'public',
                        'tblname': 'users',
                        'idxname': 'users_pkey'
                    },
                    'value': [1704067200, '2.5']
                }]
            elif 'is_na' in query:
                return [{
                    'metric': {
                        'datname': 'testdb',
                        'schemaname': 'public',
                        'tblname': 'users',
                        'idxname': 'users_pkey'
                    },
                    'value': [1704067200, '0']
                }]
            return []

        mock_prom.custom_query.side_effect = mock_query

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/btree_bloat/csv')
            assert response.status_code == 200

            # Parse CSV response
            csv_data = response.data.decode('utf-8')
            reader = csv.DictReader(io.StringIO(csv_data))
            rows = list(reader)
            assert len(rows) == 1
            assert rows[0]['database'] == 'testdb'
            assert rows[0]['schemaname'] == 'public'

    def test_btree_bloat_handles_query_errors(self, client):
        """Test btree bloat handles query errors gracefully."""
        mock_prom = Mock()
        mock_prom.custom_query.side_effect = Exception("Query failed")

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/btree_bloat/csv')
            # Should return empty CSV
            assert response.status_code == 200


class TestTableInfoEndpoint:
    """Tests for /table_info/csv endpoint."""

    def test_table_info_instant_query_mode(self, client):
        """Test table info without time params (instant mode)."""
        mock_prom = Mock()
        mock_prom.custom_query.return_value = []

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/table_info/csv')
            assert response.status_code == 200
            assert 'filename=table_stats_latest.csv' in response.headers['Content-Disposition']

    def test_table_info_rate_calculation_mode(self, client):
        """Test table info with time params (rate calculation mode)."""
        mock_prom = Mock()
        mock_prom.get_metric_range_data.return_value = []

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/table_info/csv?time_start=1704067200&time_end=1704153600')
            assert response.status_code == 200
            assert 'table_stats_' in response.headers['Content-Disposition']
            assert '.csv' in response.headers['Content-Disposition']

    def test_table_info_with_all_filters(self, client):
        """Test table info with all filters."""
        mock_prom = Mock()
        mock_prom.custom_query.return_value = []

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get(
                '/table_info/csv?cluster_name=c1&node_name=n1&db_name=db1'
                '&schemaname=public&tblname=users'
            )
            assert response.status_code == 200

    def test_table_info_with_instant_data(self, client):
        """Test table info with actual data in instant mode."""
        mock_prom = Mock()

        def mock_query(query):
            if 'total_relation_size' in query:
                return [{
                    'metric': {
                        'datname': 'testdb',
                        'schemaname': 'public',
                        'relname': 'users'
                    },
                    'value': [1704067200, '10485760']
                }]
            return []

        mock_prom.custom_query.side_effect = mock_query

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/table_info/csv')
            assert response.status_code == 200

    def test_table_info_with_rate_data(self, client):
        """Test table info with actual data in rate mode."""
        mock_prom = Mock()

        start_ts = 1704067200
        end_ts = 1704153600

        def mock_range_data(metric_name, start_time, end_time):
            if 'total_relation_size' in metric_name:
                return [{
                    'metric': {
                        'datname': 'testdb',
                        'schemaname': 'public',
                        'relname': 'users'
                    },
                    'values': [[start_ts, '10485760'], [end_ts, '20971520']]
                }]
            return []

        mock_prom.get_metric_range_data.side_effect = mock_range_data

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get(f'/table_info/csv?time_start={start_ts}&time_end={end_ts}')
            assert response.status_code == 200

    def test_table_info_iso_timestamps(self, client):
        """Test table info with ISO format timestamps."""
        mock_prom = Mock()
        mock_prom.get_metric_range_data.return_value = []

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/table_info/csv?time_start=2024-01-01T00:00:00Z&time_end=2024-01-02T00:00:00Z')
            assert response.status_code == 200


class TestMetricsEndpoint:
    """Tests for /metrics endpoint."""

    def test_list_metrics_success(self, client):
        """Test metrics listing endpoint."""
        mock_prom = Mock()
        mock_prom.all_metrics.return_value = [
            'pgwatch_pg_stat_statements_calls',
            'pgwatch_pg_stat_statements_rows',
            'other_metric'
        ]

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/metrics')
            assert response.status_code == 200
            data = json.loads(response.data)
            assert 'pg_stat_statements_metrics' in data
            # Should only include pg_stat_statements metrics
            assert len(data['pg_stat_statements_metrics']) == 2

    def test_list_metrics_error(self, client):
        """Test metrics listing handles errors."""
        mock_prom = Mock()
        mock_prom.all_metrics.side_effect = Exception("Connection failed")

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/metrics')
            assert response.status_code == 500
            data = json.loads(response.data)
            assert 'error' in data


class TestDebugMetricsEndpoint:
    """Tests for /debug/metrics endpoint."""

    def test_debug_metrics_success(self, client):
        """Test debug metrics endpoint."""
        mock_prom = Mock()
        mock_prom.all_metrics.return_value = [
            'pgwatch_pg_btree_bloat_real_size_mib',
            'pgwatch_pg_btree_bloat_extra_size',
            'other_metric'
        ]
        mock_prom.get_current_metric_value.return_value = [
            {'metric': {'datname': 'testdb', 'idxname': 'idx1'}, 'value': [0, '10']}
        ]

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/debug/metrics')
            assert response.status_code == 200
            data = json.loads(response.data)
            assert 'all_metrics_count' in data
            assert 'btree_metrics' in data
            assert 'sample_data' in data

    def test_debug_metrics_handles_sample_errors(self, client):
        """Test debug metrics handles sample data errors."""
        mock_prom = Mock()
        mock_prom.all_metrics.return_value = ['pgwatch_pg_btree_bloat_test']
        mock_prom.get_current_metric_value.side_effect = Exception("Sample failed")

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/debug/metrics')
            assert response.status_code == 200
            data = json.loads(response.data)
            assert 'sample_data' in data

    def test_debug_metrics_error(self, client):
        """Test debug metrics handles main query errors."""
        mock_prom = Mock()
        mock_prom.all_metrics.side_effect = Exception("Connection failed")

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/debug/metrics')
            assert response.status_code == 500


class TestProcessPgssData:
    """Tests for process_pgss_data function."""

    def test_process_pgss_data_empty_input(self):
        """Test with empty input."""
        start_time = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        end_time = datetime(2024, 1, 2, 0, 0, 0, tzinfo=timezone.utc)

        result = flask_app.process_pgss_data([], [], start_time, end_time)
        assert result == []

    def test_process_pgss_data_with_data(self):
        """Test with actual metric data."""
        start_time = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        end_time = datetime(2024, 1, 2, 0, 0, 0, tzinfo=timezone.utc)

        start_data = [{
            'metric': {
                '__name__': 'pgwatch_pg_stat_statements_calls',
                'datname': 'testdb',
                'queryid': '12345',
                'user': 'postgres',
                'instance': 'localhost'
            },
            'values': [[start_time.timestamp(), '100']]
        }]

        end_data = [{
            'metric': {
                '__name__': 'pgwatch_pg_stat_statements_calls',
                'datname': 'testdb',
                'queryid': '12345',
                'user': 'postgres',
                'instance': 'localhost'
            },
            'values': [[end_time.timestamp(), '200']]
        }]

        result = flask_app.process_pgss_data(start_data, end_data, start_time, end_time)
        assert len(result) == 1
        assert result[0]['queryid'] == '12345'
        assert result[0]['calls'] == 100  # Difference

    def test_process_pgss_data_sorted_by_exec_time(self):
        """Test results are sorted by exec_time descending."""
        start_time = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        end_time = datetime(2024, 1, 2, 0, 0, 0, tzinfo=timezone.utc)

        # Create data with different exec times
        start_data = [
            {
                'metric': {'__name__': 'pgwatch_pg_stat_statements_exec_time_total',
                           'datname': 'db', 'queryid': '1', 'user': 'u', 'instance': 'i'},
                'values': [[start_time.timestamp(), '100']]
            },
            {
                'metric': {'__name__': 'pgwatch_pg_stat_statements_exec_time_total',
                           'datname': 'db', 'queryid': '2', 'user': 'u', 'instance': 'i'},
                'values': [[start_time.timestamp(), '200']]
            }
        ]

        end_data = [
            {
                'metric': {'__name__': 'pgwatch_pg_stat_statements_exec_time_total',
                           'datname': 'db', 'queryid': '1', 'user': 'u', 'instance': 'i'},
                'values': [[end_time.timestamp(), '150']]  # diff = 50
            },
            {
                'metric': {'__name__': 'pgwatch_pg_stat_statements_exec_time_total',
                           'datname': 'db', 'queryid': '2', 'user': 'u', 'instance': 'i'},
                'values': [[end_time.timestamp(), '500']]  # diff = 300
            }
        ]

        result = flask_app.process_pgss_data(start_data, end_data, start_time, end_time)
        assert len(result) == 2
        # Should be sorted by exec_time descending
        assert result[0]['exec_time'] > result[1]['exec_time']


class TestPrometheusToDict:
    """Tests for prometheus_to_dict function."""

    def test_prometheus_to_dict_empty(self):
        """Test with empty input."""
        timestamp = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        result = flask_app.prometheus_to_dict([], timestamp)
        assert result == {}

    def test_prometheus_to_dict_with_data(self):
        """Test with actual data."""
        timestamp = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

        prom_data = [{
            'metric': {
                '__name__': 'pgwatch_pg_stat_statements_calls',
                'datname': 'testdb',
                'queryid': '12345',
                'user': 'postgres',
                'instance': 'localhost'
            },
            'values': [[timestamp.timestamp(), '100']]
        }]

        result = flask_app.prometheus_to_dict(prom_data, timestamp)
        assert len(result) == 1
        key = ('testdb', '12345', 'postgres', 'localhost')
        assert key in result
        assert result[key]['calls'] == 100.0

    def test_prometheus_to_dict_no_values(self):
        """Test handles entries without values."""
        timestamp = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

        prom_data = [{
            'metric': {'__name__': 'test', 'datname': 'db'},
            'values': []
        }]

        result = flask_app.prometheus_to_dict(prom_data, timestamp)
        assert result == {}

    def test_prometheus_to_dict_invalid_value(self):
        """Test handles invalid values gracefully."""
        timestamp = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

        prom_data = [{
            'metric': {
                '__name__': 'pgwatch_pg_stat_statements_calls',
                'datname': 'testdb',
                'queryid': '12345',
                'user': 'postgres',
                'instance': 'localhost'
            },
            'values': [[timestamp.timestamp(), 'invalid']]
        }]

        result = flask_app.prometheus_to_dict(prom_data, timestamp)
        # Should handle gracefully with value of 0
        key = ('testdb', '12345', 'postgres', 'localhost')
        assert key in result
        assert result[key]['calls'] == 0


class TestProcessTableStatsWithRates:
    """Tests for process_table_stats_with_rates function."""

    def test_process_table_stats_empty(self):
        """Test with empty input."""
        start_time = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        end_time = datetime(2024, 1, 2, 0, 0, 0, tzinfo=timezone.utc)

        result = flask_app.process_table_stats_with_rates({}, {}, start_time, end_time)
        assert result == []

    def test_process_table_stats_with_data(self):
        """Test with actual data."""
        start_time = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        end_time = datetime(2024, 1, 2, 0, 0, 0, tzinfo=timezone.utc)

        start_data = {
            'seq_scan': [{
                'metric': {'datname': 'db', 'schemaname': 'public', 'relname': 'users'},
                'values': [[start_time.timestamp(), '100']]
            }],
            'total_size': [{
                'metric': {'datname': 'db', 'schemaname': 'public', 'relname': 'users'},
                'values': [[start_time.timestamp(), '10485760']]
            }]
        }

        end_data = {
            'seq_scan': [{
                'metric': {'datname': 'db', 'schemaname': 'public', 'relname': 'users'},
                'values': [[end_time.timestamp(), '200']]
            }],
            'total_size': [{
                'metric': {'datname': 'db', 'schemaname': 'public', 'relname': 'users'},
                'values': [[end_time.timestamp(), '20971520']]
            }]
        }

        result = flask_app.process_table_stats_with_rates(start_data, end_data, start_time, end_time)
        assert len(result) == 1
        assert result[0]['schema'] == 'public'
        assert result[0]['table_name'] == 'users'
        assert 'seq_scans' in result[0]
        assert 'seq_scans_per_sec' in result[0]


class TestPrometheusTableToDict:
    """Tests for prometheus_table_to_dict function."""

    def test_prometheus_table_to_dict_empty(self):
        """Test with empty input."""
        timestamp = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        result = flask_app.prometheus_table_to_dict({}, timestamp)
        assert result == {}

    def test_prometheus_table_to_dict_with_data(self):
        """Test with actual data."""
        timestamp = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

        prom_data = {
            'seq_scan': [{
                'metric': {'datname': 'db', 'schemaname': 'public', 'relname': 'users'},
                'values': [[timestamp.timestamp(), '100']]
            }]
        }

        result = flask_app.prometheus_table_to_dict(prom_data, timestamp)
        key = ('db', 'public', 'users')
        assert key in result
        assert result[key]['seq_scan'] == 100.0

    def test_prometheus_table_to_dict_handles_schema_variants(self):
        """Test handles different schema label names."""
        timestamp = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

        # Test with 'schema' instead of 'schemaname'
        prom_data = {
            'seq_scan': [{
                'metric': {'datname': 'db', 'schema': 'myschema', 'table_name': 'mytable'},
                'values': [[timestamp.timestamp(), '50']]
            }]
        }

        result = flask_app.prometheus_table_to_dict(prom_data, timestamp)
        key = ('db', 'myschema', 'mytable')
        assert key in result

    def test_prometheus_table_to_dict_no_values(self):
        """Test handles entries without values."""
        timestamp = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

        prom_data = {
            'seq_scan': [{
                'metric': {'datname': 'db', 'schemaname': 'public'},
                'values': []
            }]
        }

        result = flask_app.prometheus_table_to_dict(prom_data, timestamp)
        assert result == {}


class TestMetricNameMapping:
    """Tests for METRIC_NAME_MAPPING constant."""

    def test_metric_name_mapping_exists(self):
        """Test METRIC_NAME_MAPPING has expected entries."""
        assert 'calls' in flask_app.METRIC_NAME_MAPPING
        assert 'exec_time_total' in flask_app.METRIC_NAME_MAPPING
        assert flask_app.METRIC_NAME_MAPPING['calls'] == 'calls'
        assert flask_app.METRIC_NAME_MAPPING['exec_time_total'] == 'exec_time'


class TestErrorHandling:
    """Tests for error handling in various endpoints."""

    def test_pgss_metrics_general_error(self, client):
        """Test PGSS metrics handles general errors."""
        with patch.object(flask_app, 'get_prometheus_client', side_effect=Exception("Unexpected error")):
            response = client.get('/pgss_metrics/csv?time_start=1704067200&time_end=1704153600')
            assert response.status_code == 500
            data = json.loads(response.data)
            assert 'error' in data

    def test_btree_bloat_general_error(self, client):
        """Test btree bloat handles general errors."""
        with patch.object(flask_app, 'get_prometheus_client', side_effect=Exception("Unexpected error")):
            response = client.get('/btree_bloat/csv')
            assert response.status_code == 500

    def test_table_info_general_error(self, client):
        """Test table info handles general errors."""
        with patch.object(flask_app, 'get_prometheus_client', side_effect=Exception("Unexpected error")):
            response = client.get('/table_info/csv')
            assert response.status_code == 500


class TestEdgeCases:
    """Tests for edge cases."""

    def test_zero_duration(self):
        """Test process_pgss_data handles zero duration."""
        now = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

        start_data = [{
            'metric': {
                '__name__': 'pgwatch_pg_stat_statements_calls',
                'datname': 'db', 'queryid': '1', 'user': 'u', 'instance': 'i'
            },
            'values': [[now.timestamp(), '100']]
        }]

        end_data = [{
            'metric': {
                '__name__': 'pgwatch_pg_stat_statements_calls',
                'datname': 'db', 'queryid': '1', 'user': 'u', 'instance': 'i'
            },
            'values': [[now.timestamp(), '200']]
        }]

        result = flask_app.process_pgss_data(start_data, end_data, now, now)
        assert len(result) == 1
        # per_sec should be 0 when duration is 0
        assert result[0]['calls_per_sec'] == 0

    def test_negative_difference(self):
        """Test handles counter resets (negative differences)."""
        start_time = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        end_time = datetime(2024, 1, 2, 0, 0, 0, tzinfo=timezone.utc)

        # Counter reset: end value is less than start
        start_data = [{
            'metric': {
                '__name__': 'pgwatch_pg_stat_statements_calls',
                'datname': 'db', 'queryid': '1', 'user': 'u', 'instance': 'i'
            },
            'values': [[start_time.timestamp(), '1000']]
        }]

        end_data = [{
            'metric': {
                '__name__': 'pgwatch_pg_stat_statements_calls',
                'datname': 'db', 'queryid': '1', 'user': 'u', 'instance': 'i'
            },
            'values': [[end_time.timestamp(), '100']]  # Reset occurred
        }]

        result = flask_app.process_pgss_data(start_data, end_data, start_time, end_time)
        assert len(result) == 1
        # Negative difference is allowed (indicates counter reset)
        assert result[0]['calls'] == -900

    def test_table_info_handles_list_result(self, client):
        """Test table info handles list result from process_table_stats_with_rates."""
        mock_prom = Mock()
        mock_prom.get_metric_range_data.return_value = []

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/table_info/csv?time_start=1704067200&time_end=1704153600')
            assert response.status_code == 200

    def test_process_pgss_data_missing_timestamps_fallback(self):
        """Test process_pgss_data falls back to query time when timestamps missing."""
        start_time = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        end_time = datetime(2024, 1, 2, 0, 0, 0, tzinfo=timezone.utc)

        # Data without proper timestamps in values - just start data without end
        start_data = [{
            'metric': {
                '__name__': 'pgwatch_pg_stat_statements_calls',
                'datname': 'db', 'queryid': '1', 'user': 'u', 'instance': 'i'
            },
            'values': [[start_time.timestamp(), '100']]
        }]

        # Only have start data, no matching end data (triggers fallback path)
        result = flask_app.process_pgss_data(start_data, [], start_time, end_time)
        assert len(result) == 1
        # Should use query parameter duration as fallback
        assert result[0]['duration_seconds'] == 86400  # 1 day in seconds

    def test_table_info_rate_mode_with_metric_error(self, client):
        """Test table info in rate mode handles metric query errors."""
        mock_prom = Mock()

        def mock_range_data_with_error(metric_name, start_time, end_time):
            if 'total_relation_size' in metric_name:
                raise Exception("Query failed")
            return []

        mock_prom.get_metric_range_data.side_effect = mock_range_data_with_error

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/table_info/csv?time_start=1704067200&time_end=1704153600')
            # Should still return 200 with empty/partial data
            assert response.status_code == 200

    def test_table_info_instant_mode_with_metric_error(self, client):
        """Test table info in instant mode handles metric query errors."""
        mock_prom = Mock()

        def mock_query_with_error(query):
            if 'total_relation_size' in query:
                raise Exception("Query failed")
            return []

        mock_prom.custom_query.side_effect = mock_query_with_error

        with patch.object(flask_app, 'get_prometheus_client', return_value=mock_prom):
            response = client.get('/table_info/csv')
            # Should still return 200 with empty/partial data
            assert response.status_code == 200

    def test_process_table_stats_missing_timestamps_fallback(self):
        """Test process_table_stats_with_rates falls back when timestamps missing."""
        start_time = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        end_time = datetime(2024, 1, 2, 0, 0, 0, tzinfo=timezone.utc)

        # Only start data without timestamps in the metric dict
        start_data = {
            'seq_scan': [{
                'metric': {'datname': 'db', 'schemaname': 'public', 'relname': 'users'},
                'values': [[start_time.timestamp(), '100']]
            }]
        }

        # Empty end data - triggers fallback duration calculation
        result = flask_app.process_table_stats_with_rates(start_data, {}, start_time, end_time)
        assert len(result) == 1
        # Should use query parameter duration as fallback
        assert result[0]['duration_seconds'] == 86400  # 1 day

    def test_prometheus_table_to_dict_invalid_value(self):
        """Test prometheus_table_to_dict handles invalid values."""
        timestamp = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

        prom_data = {
            'seq_scan': [{
                'metric': {'datname': 'db', 'schemaname': 'public', 'relname': 'users'},
                'values': [[timestamp.timestamp(), 'not_a_number']]
            }]
        }

        result = flask_app.prometheus_table_to_dict(prom_data, timestamp)
        key = ('db', 'public', 'users')
        assert key in result
        # Invalid value should be set to 0
        assert result[key]['seq_scan'] == 0

    def test_process_table_stats_zero_duration(self):
        """Test process_table_stats_with_rates handles zero duration."""
        now = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

        start_data = {
            'seq_scan': [{
                'metric': {'datname': 'db', 'schemaname': 'public', 'relname': 'users'},
                'values': [[now.timestamp(), '100']]
            }]
        }

        end_data = {
            'seq_scan': [{
                'metric': {'datname': 'db', 'schemaname': 'public', 'relname': 'users'},
                'values': [[now.timestamp(), '200']]
            }]
        }

        # Same start and end time = zero duration
        result = flask_app.process_table_stats_with_rates(start_data, end_data, now, now)
        assert len(result) == 1
        # Rate per second should be 0 when duration is 0
        assert result[0]['seq_scans_per_sec'] == 0
