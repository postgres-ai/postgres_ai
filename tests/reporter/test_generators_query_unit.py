from __future__ import annotations

import json
from typing import Any

import pytest

from reporter.postgres_reports import PostgresReportGenerator
from reporter.report_schemas import validate_query_file


@pytest.fixture(name="generator")
def fixture_generator() -> PostgresReportGenerator:
    return PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
    )


def _fake_metrics(cluster: str, node_name: str, db_name: str, queryid: str, hours: int) -> dict[str, Any]:
    # Return a fresh dict each call because generator pops "time_range".
    return {
        "calls": float(len(node_name) + len(db_name)),
        "total_time": float(len(queryid)),
        "rows": float(hours),
        "time_range": {
            "hours": hours,
            "start_time": "2025-01-01T00:00:00+00:00",
            "end_time": "2025-01-02T00:00:00+00:00",
        },
    }


@pytest.mark.unit
def test_generate_per_query_jsons_groups_by_queryid_and_is_node_first(
    monkeypatch: pytest.MonkeyPatch,
    generator: PostgresReportGenerator,
) -> None:
    monkeypatch.setattr(
        generator,
        "extract_queryids_from_reports",
        lambda reports: {
            "airflow_db_prod": {"qid_1"},
            "db_b": {"qid_1", "qid_2"},
        },
    )
    monkeypatch.setattr(
        generator,
        "get_queryid_queries_from_sink",
        lambda *args, **kwargs: {
            "airflow_db_prod": {"qid_1": "SELECT 1"},
            "db_b": {"qid_1": "SELECT 1", "qid_2": "SELECT 2"},
        },
    )
    monkeypatch.setattr(
        generator,
        "get_all_nodes",
        lambda cluster: {"primary": "main", "standbys": ["replica-1", "replica-2"]},
    )
    monkeypatch.setattr(generator, "get_query_metrics_from_prometheus", _fake_metrics)

    out = generator.generate_per_query_jsons(
        reports={"K001": {}},
        cluster="prod",
        node_name=None,
        hours=24,
        write_immediately=False,
    )

    assert {item["filename"] for item in out} == {"prod_query_qid_1.json", "prod_query_qid_2.json"}

    q1 = next(item["data"] for item in out if item["filename"] == "prod_query_qid_1.json")
    validate_query_file(q1)

    assert q1["cluster_id"] == "prod"
    assert q1["query_id"] == "qid_1"
    assert q1["query_text"] == "SELECT 1"
    assert q1["nodes"]["primary"] == "main"
    assert q1["nodes"]["standbys"] == ["replica-1", "replica-2"]

    # Node is the primary dimension.
    assert set(q1["results"].keys()) == {"main", "replica-1", "replica-2"}
    assert set(q1["results"]["main"].keys()) == {"airflow_db_prod", "db_b"}

    # time_range moved to top-level and removed from per-db metrics.
    assert q1["time_range"]["hours"] == 24
    assert "time_range" not in q1["results"]["main"]["airflow_db_prod"]["metrics"]


@pytest.mark.unit
def test_generate_per_query_jsons_write_immediately_prefixes_cluster_and_writes_timestamptz_last(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    generator: PostgresReportGenerator,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(generator, "extract_queryids_from_reports", lambda reports: {"db1": {"qid_1"}})
    monkeypatch.setattr(
        generator, "get_queryid_queries_from_sink", lambda *args, **kwargs: {"db1": {"qid_1": "SELECT 1"}}
    )
    monkeypatch.setattr(generator, "get_all_nodes", lambda cluster: {"primary": "main", "standbys": ["replica-1"]})
    monkeypatch.setattr(generator, "get_query_metrics_from_prometheus", _fake_metrics)

    out = generator.generate_per_query_jsons(
        reports={"K001": {}},
        cluster="prod",
        node_name=None,
        hours=24,
        write_immediately=True,
    )

    assert out == [{"filename": "prod_query_qid_1.json"}]
    p = tmp_path / "prod_query_qid_1.json"
    assert p.exists()

    payload = json.loads(p.read_text(encoding="utf-8"))
    validate_query_file(payload)

    # Ensure timestamptz is last key in the emitted JSON text (ordering requirement).
    raw = p.read_text(encoding="utf-8").rstrip()
    last_key_line = [ln for ln in raw.splitlines() if ln.lstrip().startswith('"')][-1]
    assert last_key_line.lstrip().startswith('"timestamptz"')


