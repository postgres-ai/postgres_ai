"""Tests for non-hourly aggregation code paths."""
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timedelta

from reporter.postgres_reports import PostgresReportGenerator


@pytest.fixture
def generator():
    """Create a generator instance for testing."""
    return PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
    )


@pytest.mark.unit
def test_k001_with_hourly_disabled(generator) -> None:
    """Test K001 report generation with use_hourly=False."""
    with patch.object(generator, 'get_all_databases', return_value=["testdb"]):
        with patch.object(generator, '_get_pgss_metrics_data_by_db', return_value=[
            {"queryid": "123", "calls": 100, "total_time": 500.0, "rows": 1000}
        ]):
            with patch.object(generator, '_get_postgres_version_info', return_value={"version": "14.0"}):
                report = generator.generate_k001_query_calls_report(
                    cluster="test-cluster",
                    node_name="node-01",
                    time_range_minutes=60,
                    use_hourly=False  # Trigger non-hourly path
                )

    assert report["checkId"] == "K001"
    assert "results" in report
    node_data = report["results"]["node-01"]["data"]
    assert "testdb" in node_data


@pytest.mark.unit
def test_k001_with_time_range_less_than_60(generator) -> None:
    """Test K001 with time_range_minutes < 60 triggers non-hourly path."""
    with patch.object(generator, 'get_all_databases', return_value=["testdb"]):
        with patch.object(generator, '_get_pgss_metrics_data_by_db', return_value=[
            {"queryid": "456", "calls": 50}
        ]):
            with patch.object(generator, '_get_postgres_version_info', return_value={"version": "15.0"}):
                report = generator.generate_k001_query_calls_report(
                    cluster="test-cluster",
                    node_name="node-01",
                    time_range_minutes=30,  # Less than 60, triggers non-hourly
                    use_hourly=True  # Even with True, time < 60 triggers fallback
                )

    assert report["checkId"] == "K001"


@pytest.mark.unit
def test_k003_with_hourly_disabled(generator) -> None:
    """Test K003 report generation with use_hourly=False."""
    with patch.object(generator, 'get_all_databases', return_value=["db1"]):
        with patch.object(generator, '_get_pgss_metrics_data_by_db', return_value=[
            {"queryid": "789", "total_time": 1000.0, "calls": 10}
        ]):
            with patch.object(generator, '_get_postgres_version_info', return_value={"version": "14.5"}):
                report = generator.generate_k003_top_queries_report(
                    cluster="test-cluster",
                    node_name="node-01",
                    time_range_minutes=60,
                    use_hourly=False
                )

    assert report["checkId"] == "K003"


@pytest.mark.unit
def test_k004_with_hourly_disabled(generator) -> None:
    """Test K004 report generation with use_hourly=False."""
    with patch.object(generator, 'get_all_databases', return_value=["db1"]):
        with patch.object(generator, '_get_pgss_metrics_data_by_db', return_value=[
            {"queryid": "111", "temp_bytes_read": 5000, "temp_bytes_written": 3000}
        ]):
            with patch.object(generator, '_get_postgres_version_info', return_value={"version": "14.0"}):
                report = generator.generate_k004_temp_bytes_report(
                    cluster="test-cluster",
                    node_name="node-01",
                    time_range_minutes=60,
                    use_hourly=False
                )

    assert report["checkId"] == "K004"


@pytest.mark.unit
def test_k005_with_hourly_disabled(generator) -> None:
    """Test K005 report generation with use_hourly=False."""
    with patch.object(generator, 'get_all_databases', return_value=["db1"]):
        with patch.object(generator, '_get_pgss_metrics_data_by_db', return_value=[
            {"queryid": "222", "wal_bytes": 8000}
        ]):
            with patch.object(generator, '_get_postgres_version_info', return_value={"version": "14.0"}):
                report = generator.generate_k005_wal_bytes_report(
                    cluster="test-cluster",
                    node_name="node-01",
                    time_range_minutes=60,
                    use_hourly=False
                )

    assert report["checkId"] == "K005"


@pytest.mark.unit
def test_k006_with_hourly_disabled(generator) -> None:
    """Test K006 report generation with use_hourly=False."""
    with patch.object(generator, 'get_all_databases', return_value=["db1"]):
        with patch.object(generator, '_get_pgss_metrics_data_by_db', return_value=[
            {"queryid": "333", "shared_blks_read": 1000}
        ]):
            with patch.object(generator, '_get_postgres_version_info', return_value={"version": "14.0"}):
                report = generator.generate_k006_shared_read_report(
                    cluster="test-cluster",
                    node_name="node-01",
                    time_range_minutes=60,
                    use_hourly=False
                )

    assert report["checkId"] == "K006"


@pytest.mark.unit
def test_get_pgss_metrics_with_query_range(generator) -> None:
    """Test _get_pgss_metrics_data_by_db method directly."""
    start_time = datetime.now() - timedelta(hours=1)
    end_time = datetime.now()

    # Mock query_range to return data in expected format
    mock_start_data = [
        {
            "metric": {
                "cluster": "test",
                "node_name": "node-01",
                "datname": "testdb",
                "queryid": "123"
            },
            "values": [[start_time.timestamp(), "100"]]
        }
    ]

    mock_end_data = [
        {
            "metric": {
                "cluster": "test",
                "node_name": "node-01",
                "datname": "testdb",
                "queryid": "123"
            },
            "values": [[end_time.timestamp(), "200"]]
        }
    ]

    with patch.object(generator, 'query_range', side_effect=[
        mock_start_data, mock_end_data,  # calls metric
        mock_start_data, mock_end_data,  # exec_time_total
        [], [],  # rows - no data
        [], [],  # shared_bytes_hit_total
        [], [],  # shared_bytes_read_total
        [], [],  # shared_bytes_dirtied_total
        [], [],  # shared_bytes_written_total
        [], [],  # block_read_total
        [], [],  # block_write_total
    ]):
        with patch.object(generator, '_process_pgss_data', return_value=[
            {"queryid": "123", "calls": 100, "total_time": 500.0}
        ]) as mock_process:
            result = generator._get_pgss_metrics_data_by_db(
                "test", "node-01", "testdb", start_time, end_time
            )

            # Should have called _process_pgss_data
            assert mock_process.called
            assert isinstance(result, list)


@pytest.mark.unit
def test_get_query_metrics_from_prometheus(generator) -> None:
    """Test get_query_metrics_from_prometheus method."""
    mock_result = {
        "status": "success",
        "data": {
            "result": [
                {
                    "value": [1234567890, "100"]
                }
            ]
        }
    }

    with patch.object(generator, 'query_instant', return_value=mock_result):
        metrics = generator.get_query_metrics_from_prometheus(
            cluster="test",
            node_name="node-01",
            db_name="testdb",
            queryid="123",
            hours=24
        )

    assert isinstance(metrics, dict)
    assert "time_range" in metrics
    assert metrics["time_range"]["hours"] == 24


@pytest.mark.unit
def test_get_query_metrics_handles_empty_results(generator) -> None:
    """Test get_query_metrics_from_prometheus with empty results."""
    mock_empty = {
        "status": "success",
        "data": {
            "result": []
        }
    }

    with patch.object(generator, 'query_instant', return_value=mock_empty):
        metrics = generator.get_query_metrics_from_prometheus(
            cluster="test",
            node_name="node-01",
            db_name="testdb",
            queryid="999",
            hours=12
        )

    # Should only have time_range, no actual metrics
    assert "time_range" in metrics
    assert metrics["time_range"]["hours"] == 12


@pytest.mark.unit
def test_get_query_metrics_handles_errors_silently(generator) -> None:
    """Test get_query_metrics_from_prometheus handles query errors."""
    # query_instant raises exceptions for some metrics
    def mock_query_instant(query):
        if "calls" in query:
            return {
                "status": "success",
                "data": {"result": [{"value": [0, "50"]}]}
            }
        raise Exception("Metric not available")

    with patch.object(generator, 'query_instant', side_effect=mock_query_instant):
        metrics = generator.get_query_metrics_from_prometheus(
            cluster="test",
            node_name="node-01",
            db_name="testdb",
            queryid="456",
            hours=6
        )

    # Should have calls metric but silently skip errored metrics
    assert "calls" in metrics
    assert "time_range" in metrics


@pytest.mark.unit
def test_get_query_metrics_filters_zero_values(generator) -> None:
    """Test that get_query_metrics_from_prometheus filters out zero values."""
    def mock_query_instant(query):
        if "calls" in query:
            return {"status": "success", "data": {"result": [{"value": [0, "100"]}]}}
        else:
            # Other metrics return 0
            return {"status": "success", "data": {"result": [{"value": [0, "0"]}]}}

    with patch.object(generator, 'query_instant', side_effect=mock_query_instant):
        metrics = generator.get_query_metrics_from_prometheus(
            cluster="test",
            node_name="node-01",
            db_name="testdb",
            queryid="789",
            hours=1
        )

    # Only non-zero metrics should be included
    assert "calls" in metrics
    assert metrics["calls"] == 100.0
    # Zero-value metrics should not be in the dict
    assert "rows" not in metrics or metrics.get("rows", 0) == 0
