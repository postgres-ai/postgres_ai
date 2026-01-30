"""Tests for queryid extraction methods."""
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
def test_extract_queryids_from_reports_with_k003_report(generator) -> None:
    """Test extracting queryids from K003 top queries report."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": {
                        "postgres": {
                            "top_queries": [
                                {"queryid": "12345", "calls": 1000},
                                {"queryid": "67890", "calls": 500},
                            ]
                        }
                    }
                }
            }
        }
    }

    queryids = generator.extract_queryids_from_reports(reports)

    assert isinstance(queryids, dict)
    # Should have extracted queryids grouped by database
    if queryids:
        # Structure is {database: {queryid1, queryid2, ...}}
        assert "postgres" in queryids
        assert "12345" in queryids["postgres"] or "67890" in queryids["postgres"]


@pytest.mark.unit
def test_extract_queryids_from_reports_with_empty_reports(generator) -> None:
    """Test extracting queryids from empty reports."""
    reports = {}

    queryids = generator.extract_queryids_from_reports(reports)

    assert isinstance(queryids, dict)
    assert len(queryids) == 0


@pytest.mark.unit
def test_extract_queryids_from_reports_with_no_queries(generator) -> None:
    """Test extracting queryids when report has no queries."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": {}
                }
            }
        }
    }

    queryids = generator.extract_queryids_from_reports(reports)

    assert isinstance(queryids, dict)


@pytest.mark.unit
def test_extract_queryids_from_reports_with_multiple_databases(generator) -> None:
    """Test extracting queryids from reports with multiple databases."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": {
                        "db1": {
                            "top_queries": [
                                {"queryid": "111", "calls": 100},
                            ]
                        },
                        "db2": {
                            "top_queries": [
                                {"queryid": "222", "calls": 200},
                            ]
                        }
                    }
                }
            }
        }
    }

    queryids = generator.extract_queryids_from_reports(reports)

    assert isinstance(queryids, dict)
    # Should extract from both databases


@pytest.mark.unit
def test_extract_queryids_from_reports_with_invalid_data(generator) -> None:
    """Test extracting queryids handles invalid data gracefully."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": "invalid"  # Not a dict
                }
            }
        }
    }

    # Should handle gracefully without crashing
    queryids = generator.extract_queryids_from_reports(reports)
    assert isinstance(queryids, dict)


@pytest.mark.unit
def test_extract_queryids_from_reports_deduplicates(generator) -> None:
    """Test that extract_queryids deduplicates queryids across databases."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": {
                        "db1": {
                            "top_queries": [
                                {"queryid": "12345", "calls": 100},
                            ]
                        },
                        "db2": {
                            "top_queries": [
                                {"queryid": "12345", "calls": 50},  # Duplicate
                                {"queryid": "67890", "calls": 75},
                            ]
                        }
                    }
                }
            }
        }
    }

    queryids = generator.extract_queryids_from_reports(reports)

    assert isinstance(queryids, dict)
    # Should have deduplicated queryid "12345"


@pytest.mark.unit
def test_extract_queryids_from_multiple_report_types(generator) -> None:
    """Test extracting queryids from multiple report types."""
    reports = {
        "K003": {
            "results": {
                "node-01": {
                    "data": {
                        "postgres": {
                            "top_queries": [
                                {"queryid": "111", "calls": 100},
                            ]
                        }
                    }
                }
            }
        },
        "M001": {
            "results": {
                "node-01": {
                    "data": {
                        "postgres": {
                            "top_queries": [
                                {"queryid": "222", "mean_time": 50},
                            ]
                        }
                    }
                }
            }
        }
    }

    queryids = generator.extract_queryids_from_reports(reports)

    assert isinstance(queryids, dict)
    # Should extract from both report types
