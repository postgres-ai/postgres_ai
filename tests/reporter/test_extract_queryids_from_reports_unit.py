from __future__ import annotations

import pytest

from reporter.postgres_reports import PostgresReportGenerator


@pytest.fixture(name="generator")
def fixture_generator() -> PostgresReportGenerator:
    return PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
    )


@pytest.mark.unit
def test_extract_queryids_from_reports_includes_query_metrics_and_top_queries(
    generator: PostgresReportGenerator,
) -> None:
    reports = {
        # K001-style report: query_metrics
        "K001": {
            "results": {
                "node-1": {
                    "data": {
                        "db1": {
                            "query_metrics": [
                                {"queryid": "1"},
                                {"queryid": "0"},  # excluded
                                {"queryid": 2},  # int form
                            ]
                        }
                    }
                }
            }
        },
        # K003-style report: top_queries
        "K003": {
            "results": {
                "node-1": {
                    "data": {
                        "db1": {
                            "top_queries": [
                                {"queryid": "3"},
                                {"queryid": "-4"},
                            ]
                        },
                        "db2": {
                            "top_queries": [
                                {"queryid": "5"},
                            ]
                        },
                    }
                }
            }
        },
        # D004 has sample_queries but should NOT be used for per-query file generation.
        "D004": {
            "results": {
                "node-1": {
                    "data": {
                        "pg_stat_statements_status": {
                            "sample_queries": [
                                {"queryid": "999"},
                            ]
                        }
                    }
                }
            }
        },
    }

    out = generator.extract_queryids_from_reports(reports)

    assert out["db1"] == {"1", "2", "3", "-4"}
    assert out["db2"] == {"5"}
    assert "999" not in (out["db1"] | out["db2"])


@pytest.mark.unit
def test_extract_queryids_from_reports_n001_includes_nonzero_query_id_only(
    generator: PostgresReportGenerator,
) -> None:
    reports = {
        "N001": {
            "results": {
                "node-1": {
                    "data": {
                        "db1": {
                            "wait_event_types": {
                                "CPU*": {
                                    "queries_list": [
                                        {"query_id": "0"},  # excluded
                                        {"query_id": "10"},
                                    ]
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    out = generator.extract_queryids_from_reports(reports)

    assert out == {"db1": {"10"}}


@pytest.mark.unit
def test_extract_queryids_from_reports_d004_only_is_empty(
    generator: PostgresReportGenerator,
) -> None:
    reports = {
        "D004": {
            "results": {
                "node-1": {
                    "data": {
                        "pg_stat_statements_status": {
                            "sample_queries": [
                                {"queryid": "-1100697950502680692"},
                                {"queryid": "-115926913472768758"},
                            ]
                        }
                    }
                }
            }
        }
    }

    out = generator.extract_queryids_from_reports(reports)
    assert out == {}


