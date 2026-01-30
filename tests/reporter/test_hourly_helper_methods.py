"""Tests for hourly aggregation helper methods."""
import pytest
from datetime import datetime
from unittest.mock import Mock, patch

from reporter.postgres_reports import PostgresReportGenerator


@pytest.fixture
def generator():
    """Create a generator instance for testing."""
    return PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
    )


@pytest.mark.unit
def test_floor_hour_with_use_current_time_false(generator) -> None:
    """Test _floor_hour floors timestamp to nearest hour."""
    # 2024-01-01 12:34:56 -> 2024-01-01 12:00:00
    ts = 1704110096  # Some timestamp
    floored = generator._floor_hour(ts)

    # Should be floored to hour boundary
    assert floored % 3600 == 0
    assert floored <= ts
    assert ts - floored < 3600


@pytest.mark.unit
def test_floor_hour_with_use_current_time_true() -> None:
    """Test _floor_hour returns original timestamp when use_current_time=True."""
    generator = PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
        use_current_time=True
    )

    ts = 1704110096  # Not on hour boundary
    floored = generator._floor_hour(ts)

    # Should return original timestamp
    assert floored == ts


@pytest.mark.unit
def test_build_timeline_default_24_hours(generator) -> None:
    """Test _build_timeline builds 24-hour timeline."""
    end_s = 1704110400  # Some hour boundary

    start_s, timeline = generator._build_timeline(end_s, hours=24, step_s=3600)

    # Should have 24 points
    assert len(timeline) == 24
    # First point should be start_s
    assert timeline[0] == start_s
    # Last point should be end_s
    assert timeline[-1] == end_s
    # Each step should be 1 hour
    for i in range(len(timeline) - 1):
        assert timeline[i+1] - timeline[i] == 3600


@pytest.mark.unit
def test_build_timeline_custom_hours_and_step(generator) -> None:
    """Test _build_timeline with custom hours and step."""
    end_s = 1704110400

    start_s, timeline = generator._build_timeline(end_s, hours=12, step_s=1800)

    # Should have 12 points
    assert len(timeline) == 12
    # Each step should be 30 minutes (1800s)
    for i in range(len(timeline) - 1):
        assert timeline[i+1] - timeline[i] == 1800


@pytest.mark.unit
def test_build_qid_regex_with_single_queryid(generator) -> None:
    """Test _build_qid_regex with single query ID."""
    regex = generator._build_qid_regex(["12345"])

    assert regex == "^(?:12345)$"


@pytest.mark.unit
def test_build_qid_regex_with_multiple_queryids(generator) -> None:
    """Test _build_qid_regex with multiple query IDs."""
    regex = generator._build_qid_regex(["12345", "67890", "11111"])

    assert regex == "^(?:12345|67890|11111)$"


@pytest.mark.unit
def test_build_qid_regex_with_negative_queryid(generator) -> None:
    """Test _build_qid_regex handles negative query IDs."""
    regex = generator._build_qid_regex(["-1", "12345", "-999"])

    assert regex == "^(?:-1|12345|-999)$"


@pytest.mark.unit
def test_build_qid_regex_with_invalid_queryid(generator) -> None:
    """Test _build_qid_regex raises ValueError for invalid query IDs."""
    with pytest.raises(ValueError, match="Unexpected queryid"):
        generator._build_qid_regex(["12345", "invalid_id", "67890"])

    with pytest.raises(ValueError, match="Unexpected queryid"):
        generator._build_qid_regex(["12345abc"])


@pytest.mark.unit
def test_to_series_map_with_valid_data(generator) -> None:
    """Test _to_series_map converts Prometheus result to series map."""
    result = [
        {
            "metric": {"queryid": "12345"},
            "values": [
                [1704110400, "100"],
                [1704114000, "200"],
                [1704117600, "300"]
            ]
        },
        {
            "metric": {"queryid": "67890"},
            "values": [
                [1704110400, "50"],
                [1704114000, "75"]
            ]
        }
    ]

    series_map = generator._to_series_map(result)

    assert "12345" in series_map
    assert "67890" in series_map
    assert series_map["12345"][1704110400] == 100.0
    assert series_map["12345"][1704114000] == 200.0
    assert series_map["67890"][1704110400] == 50.0


@pytest.mark.unit
def test_to_series_map_with_missing_queryid(generator) -> None:
    """Test _to_series_map uses __single__ for missing queryid."""
    result = [
        {
            "metric": {},  # No queryid
            "values": [[1704110400, "100"]]
        }
    ]

    series_map = generator._to_series_map(result)

    assert "__single__" in series_map
    assert series_map["__single__"][1704110400] == 100.0


@pytest.mark.unit
def test_to_series_map_with_empty_result(generator) -> None:
    """Test _to_series_map handles empty result."""
    series_map = generator._to_series_map([])

    assert series_map == {}


@pytest.mark.unit
def test_densify_fills_missing_values(generator) -> None:
    """Test _densify fills missing values with default fill value."""
    series_pts = {
        "12345": {1704110400: 100.0, 1704117600: 300.0},  # Missing middle point
        "67890": {1704110400: 50.0, 1704114000: 75.0, 1704117600: 100.0}
    }
    timeline = [1704110400, 1704114000, 1704117600]
    qids = ["12345", "67890"]

    densified = generator._densify(series_pts, qids, timeline, fill=0.0)

    assert densified["12345"] == [100.0, 0.0, 300.0]  # Middle filled with 0
    assert densified["67890"] == [50.0, 75.0, 100.0]  # No gaps


@pytest.mark.unit
def test_densify_with_custom_fill_value(generator) -> None:
    """Test _densify with custom fill value."""
    series_pts = {
        "12345": {1704110400: 100.0}  # Only first point
    }
    timeline = [1704110400, 1704114000, 1704117600]
    qids = ["12345"]

    densified = generator._densify(series_pts, qids, timeline, fill=-1.0)

    assert densified["12345"] == [100.0, -1.0, -1.0]


@pytest.mark.unit
def test_densify_with_completely_missing_query(generator) -> None:
    """Test _densify handles query not in series_pts."""
    series_pts = {
        "12345": {1704110400: 100.0}
    }
    timeline = [1704110400, 1704114000, 1704117600]
    qids = ["12345", "99999"]  # 99999 not in series_pts

    densified = generator._densify(series_pts, qids, timeline, fill=0.0)

    assert densified["12345"] == [100.0, 0.0, 0.0]
    assert densified["99999"] == [0.0, 0.0, 0.0]  # All filled


@pytest.mark.unit
def test_get_all_databases_excludes_default_databases(generator) -> None:
    """Test get_all_databases excludes default system databases."""
    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "status": "success",
        "data": {
            "result": [
                {"metric": {"datname": "myapp"}},
                {"metric": {"datname": "template0"}},  # Should be excluded
                {"metric": {"datname": "template1"}},  # Should be excluded
                {"metric": {"datname": "postgres"}},
                {"metric": {"datname": "rdsadmin"}},  # Should be excluded
            ]
        }
    }

    with patch("reporter.postgres_reports.requests.get", return_value=mock_response):
        databases = generator.get_all_databases("test-cluster")

        assert "myapp" in databases
        assert "postgres" in databases
        assert "template0" not in databases
        assert "template1" not in databases
        assert "rdsadmin" not in databases


@pytest.mark.unit
def test_get_all_databases_with_custom_excluded_databases() -> None:
    """Test get_all_databases with custom excluded databases."""
    generator = PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
        excluded_databases=["mytest", "staging"]
    )

    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "status": "success",
        "data": {
            "result": [
                {"metric": {"datname": "production"}},
                {"metric": {"datname": "mytest"}},  # Should be excluded (custom)
                {"metric": {"datname": "staging"}},  # Should be excluded (custom)
                {"metric": {"datname": "template0"}},  # Should be excluded (default)
            ]
        }
    }

    with patch("reporter.postgres_reports.requests.get", return_value=mock_response):
        databases = generator.get_all_databases("test-cluster")

        assert "production" in databases
        assert "mytest" not in databases
        assert "staging" not in databases
        assert "template0" not in databases
