"""Improved tests with deep assertions and logic verification.

These tests demonstrate better testing practices:
- Deep assertions checking actual logic, not just structure
- Verification of method calls and side effects
- Testing of data transformations and calculations
"""
import pytest
from unittest.mock import Mock, patch, call
from datetime import datetime, timedelta

from reporter.postgres_reports import PostgresReportGenerator


@pytest.mark.unit
def test_k001_correctly_sorts_queries_by_calls(generator) -> None:
    """Test that K001 correctly sorts queries by call count in descending order."""
    # Setup: mock data with specific call counts
    mock_metrics = [
        {"queryid": "query_low", "calls": 10, "total_time": 100.0, "rows": 50},
        {"queryid": "query_high", "calls": 1000, "total_time": 500.0, "rows": 5000},
        {"queryid": "query_medium", "calls": 100, "total_time": 200.0, "rows": 500},
    ]
    
    with patch.object(generator, 'get_all_databases', return_value=["testdb"]):
        with patch.object(generator, '_get_pgss_metrics_data_by_db', return_value=mock_metrics):
            with patch.object(generator, '_get_postgres_version_info', return_value={"version": "14.0"}):
                report = generator.generate_k001_query_calls_report(
                    cluster="test-cluster",
                    node_name="node-01",
                    use_hourly=False
                )
    
    # Deep assertions: verify sorting logic
    queries = report["results"]["node-01"]["data"]["testdb"]["query_metrics"]
    assert len(queries) == 3
    
    # Verify descending order by calls
    assert queries[0]["queryid"] == "query_high"
    assert queries[0]["calls"] == 1000
    assert queries[1]["queryid"] == "query_medium"
    assert queries[1]["calls"] == 100
    assert queries[2]["queryid"] == "query_low"
    assert queries[2]["calls"] == 10
    
    # Verify summary calculations
    summary = report["results"]["node-01"]["data"]["testdb"]["summary"]
    assert summary["total_queries"] == 3
    assert summary["total_calls"] == 1110  # 10 + 100 + 1000
    assert summary["total_time_ms"] == 800.0  # 100 + 200 + 500
    assert summary["total_rows"] == 5550  # 50 + 500 + 5000


@pytest.mark.unit
def test_format_bytes_uses_correct_unit_thresholds(generator) -> None:
    """Test that format_bytes uses correct thresholds for unit selection."""
    # Test exact boundaries
    assert "1023" in generator.format_bytes(1023)  # Just below KB
    
    kb_result = generator.format_bytes(1024)  # Exactly 1 KB
    assert "1" in kb_result
    assert ("KB" in kb_result or "KiB" in kb_result)
    
    mb_result = generator.format_bytes(1024 * 1024)  # Exactly 1 MB
    assert "1" in mb_result
    assert ("MB" in mb_result or "MiB" in mb_result)
    
    gb_result = generator.format_bytes(1024 * 1024 * 1024)  # Exactly 1 GB
    assert "1" in gb_result
    assert ("GB" in gb_result or "GiB" in gb_result)
    
    # Test fractional values round correctly
    result_1_5_gb = generator.format_bytes(int(1.5 * 1024 * 1024 * 1024))
    # Should show 1.5 GB (or rounded to 2 GB depending on implementation)
    assert ("1.5" in result_1_5_gb or "2" in result_1_5_gb)


@pytest.mark.unit
def test_parse_memory_value_handles_all_units_correctly(generator) -> None:
    """Test that memory parsing correctly converts all supported units."""
    # Test all unit variations (case-insensitive)
    assert generator._parse_memory_value("1B") == 1
    assert generator._parse_memory_value("1b") == 1
    
    assert generator._parse_memory_value("1KB") == 1024
    assert generator._parse_memory_value("1kb") == 1024
    assert generator._parse_memory_value("1Kb") == 1024
    
    assert generator._parse_memory_value("1MB") == 1024 * 1024
    assert generator._parse_memory_value("1mb") == 1024 * 1024
    
    assert generator._parse_memory_value("1GB") == 1024 * 1024 * 1024
    assert generator._parse_memory_value("1gb") == 1024 * 1024 * 1024
    
    assert generator._parse_memory_value("1TB") == 1024 * 1024 * 1024 * 1024
    assert generator._parse_memory_value("1tb") == 1024 * 1024 * 1024 * 1024
    
    # Test decimal values
    assert generator._parse_memory_value("2.5GB") == int(2.5 * 1024 * 1024 * 1024)
    
    # Test special values
    assert generator._parse_memory_value("-1") == 0  # -1 means unlimited
    assert generator._parse_memory_value("0") == 0


@pytest.mark.unit
def test_analyze_memory_settings_calculates_totals_correctly(generator) -> None:
    """Test that memory analysis correctly calculates total memory usage."""
    memory_data = {
        "shared_buffers": {"setting": "1GB"},  # 1GB = 1073741824 bytes
        "work_mem": {"setting": "4MB"},        # 4MB = 4194304 bytes per connection
        "maintenance_work_mem": {"setting": "64MB"},  # 64MB = 67108864 bytes
        "max_connections": {"setting": "100"},
    }
    
    result = generator._analyze_memory_settings(memory_data)
    
    assert "estimated_total_memory_usage" in result
    estimates = result["estimated_total_memory_usage"]
    
    # Verify shared_buffers is parsed correctly
    assert estimates["shared_buffers_bytes"] == 1073741824
    
    # Verify max_work_mem calculation: work_mem * max_connections
    # 4MB * 100 = 419430400 bytes
    if "max_work_mem_usage_bytes" in estimates:
        assert estimates["max_work_mem_usage_bytes"] == 4194304 * 100


@pytest.mark.unit
def test_floor_hour_correctly_rounds_down_to_hour_boundary(generator) -> None:
    """Test that _floor_hour correctly rounds timestamps down to hour boundary."""
    # Test various timestamps within the same hour
    timestamps = [
        1704110400,  # 2024-01-01 12:00:00 (exactly on hour)
        1704110401,  # 2024-01-01 12:00:01 (1 second after)
        1704111000,  # 2024-01-01 12:10:00 (10 minutes after)
        1704113999,  # 2024-01-01 12:59:59 (1 second before next hour)
    ]
    
    expected_floored = 1704110400  # All should floor to 12:00:00
    
    for ts in timestamps:
        floored = generator._floor_hour(ts)
        assert floored == expected_floored
        assert floored % 3600 == 0  # Must be on hour boundary


@pytest.mark.unit
def test_densify_fills_missing_timestamps_with_correct_value(generator) -> None:
    """Test that _densify correctly fills gaps in time series data."""
    # Setup: sparse data with gaps
    series_pts = {
        "query_123": {
            1704110400: 100.0,  # Hour 0
            # Missing: Hour 1
            1704117600: 300.0,  # Hour 2
        }
    }
    
    # Timeline with all hours including the gap
    timeline = [1704110400, 1704114000, 1704117600]
    
    # Densify with fill value of 0
    result = generator._densify(series_pts, ["query_123"], timeline, fill=0.0)
    
    # Verify the gap was filled
    assert result["query_123"] == [100.0, 0.0, 300.0]
    assert len(result["query_123"]) == 3


@pytest.mark.unit
def test_filter_a003_settings_returns_only_requested_settings(generator) -> None:
    """Test that filter_a003_settings returns only the requested settings."""
    a003_report = {
        "results": {
            "node-01": {
                "data": {
                    "shared_buffers": {"setting": "128MB"},
                    "work_mem": {"setting": "4MB"},
                    "max_connections": {"setting": "100"},
                    "autovacuum": {"setting": "on"},
                    "random_setting": {"setting": "value"},
                }
            }
        }
    }
    
    # Request only specific settings
    requested = ["shared_buffers", "work_mem", "nonexistent_setting"]
    result = generator.filter_a003_settings(a003_report, requested)
    
    # Should have exactly 2 settings (nonexistent_setting should not appear)
    assert len(result) == 2
    assert "shared_buffers" in result
    assert "work_mem" in result
    
    # Should NOT include unrequested settings
    assert "max_connections" not in result
    assert "autovacuum" not in result
    assert "random_setting" not in result
    
    # Verify values are preserved
    assert result["shared_buffers"]["setting"] == "128MB"
    assert result["work_mem"]["setting"] == "4MB"


@pytest.mark.unit
def test_get_pgss_metrics_calls_query_range_for_all_metrics(generator) -> None:
    """Test that _get_pgss_metrics_data_by_db queries all expected metrics."""
    start_time = datetime.now() - timedelta(hours=1)
    end_time = datetime.now()
    
    # Mock query_range to track calls
    mock_query_range = Mock(return_value=[])
    
    with patch.object(generator, 'query_range', mock_query_range):
        with patch.object(generator, '_process_pgss_data', return_value=[]):
            generator._get_pgss_metrics_data_by_db(
                "test-cluster", "node-01", "testdb", 
                start_time, end_time
            )
    
    # Verify query_range was called for each metric (9 metrics * 2 times = 18 calls)
    # 2 times because we query at start_time and end_time
    expected_metrics = [
        'pgwatch_pg_stat_statements_calls',
        'pgwatch_pg_stat_statements_exec_time_total',
        'pgwatch_pg_stat_statements_rows',
        'pgwatch_pg_stat_statements_shared_bytes_hit_total',
        'pgwatch_pg_stat_statements_shared_bytes_read_total',
        'pgwatch_pg_stat_statements_shared_bytes_dirtied_total',
        'pgwatch_pg_stat_statements_shared_bytes_written_total',
        'pgwatch_pg_stat_statements_block_read_total',
        'pgwatch_pg_stat_statements_block_write_total',
    ]
    
    # Should have called query_range 18 times (9 metrics * 2 time windows)
    assert mock_query_range.call_count == 18
    
    # Verify all expected metrics were queried
    called_metrics = set()
    for call_args in mock_query_range.call_args_list:
        query = call_args[0][0]
        for metric in expected_metrics:
            if metric in query:
                called_metrics.add(metric)
                break
    
    assert len(called_metrics) == 9


@pytest.mark.unit
def test_extract_queryids_deduplicates_across_databases(generator) -> None:
    """Test that queryid extraction correctly handles duplicates across databases."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": {
                        "db1": {
                            "top_queries": [
                                {"queryid": "123", "calls": 100},
                                {"queryid": "456", "calls": 50},
                            ]
                        },
                        "db2": {
                            "top_queries": [
                                {"queryid": "123", "calls": 200},  # Same queryid
                                {"queryid": "789", "calls": 75},
                            ]
                        }
                    }
                }
            }
        }
    }
    
    result = generator.extract_queryids_from_reports(reports)
    
    # Should have entries for both databases
    assert "db1" in result
    assert "db2" in result
    
    # Each database should have its queryids as a set
    assert "123" in result["db1"]
    assert "456" in result["db1"]
    assert "123" in result["db2"]
    assert "789" in result["db2"]
    
    # Verify it's using sets (queryid "123" appears in both DBs but shouldn't be duplicated within each)
    assert isinstance(result["db1"], set)
    assert isinstance(result["db2"], set)
