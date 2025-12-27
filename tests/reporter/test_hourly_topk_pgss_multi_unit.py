from __future__ import annotations

from typing import Any

import pytest

import reporter.postgres_reports as pr
from reporter.postgres_reports import PostgresReportGenerator


@pytest.fixture(name="generator")
def fixture_generator() -> PostgresReportGenerator:
    return PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
    )


@pytest.mark.unit
def test_hourly_topk_multi_clamps_negative_other_and_warns(
    monkeypatch: pytest.MonkeyPatch,
    generator: PostgresReportGenerator,
    series_sample,
) -> None:
    # Make timeline deterministic (avoid relying on wall clock / hour boundaries).
    monkeypatch.setattr(generator, "_floor_hour", lambda _ts: 200)
    monkeypatch.setattr(generator, "_build_timeline", lambda _end_s, _hours, _step_s: (100, [100, 200]))

    warnings: list[str] = []
    monkeypatch.setattr(pr.logger, "warning", lambda msg: warnings.append(str(msg)))

    def fake_query_range(_query: str, start, end, step: str = "3600s") -> list[dict[str, Any]]:
        _ = (start, end, step)
        # topk(...) union selection
        if _query.startswith("topk("):
            return [series_sample("dummy", labels={"queryid": "1"}, values=[(100, 0), (200, 0)])]
        # total query - return no series, so totals become 0.0
        if "sum(increase(" in _query and "queryid" not in _query:
            return []
        # union query - per queryid series (already aggregated by the query)
        if "sum by (queryid)" in _query:
            return [series_sample("dummy", labels={"queryid": "1"}, values=[(100, 5.0), (200, 5.0)])]
        raise AssertionError(f"Unexpected query: {_query}")

    monkeypatch.setattr(generator, "query_range", fake_query_range)

    per_query, other, timeline = generator._get_hourly_topk_pgss_data_sum2(
        cluster="local",
        node_name="node-1",
        db_name="db1",
        metric_name_a="metric_a",
        metric_name_b="metric_b",
        hours=2,
        step_s=3600,
        k=3,
    )

    assert timeline == [100, 200]
    assert per_query["1"] == pytest.approx([5.0, 5.0])
    assert other == pytest.approx([0.0, 0.0])
    assert len(warnings) == 1
    assert "negative 'other' clamped to 0" in warnings[0]


@pytest.mark.unit
def test_hourly_topk_multi_tiny_negative_other_is_silently_clamped(
    monkeypatch: pytest.MonkeyPatch,
    generator: PostgresReportGenerator,
    series_sample,
) -> None:
    monkeypatch.setattr(generator, "_floor_hour", lambda _ts: 200)
    monkeypatch.setattr(generator, "_build_timeline", lambda _end_s, _hours, _step_s: (100, [100, 200]))

    warnings: list[str] = []
    monkeypatch.setattr(pr.logger, "warning", lambda msg: warnings.append(str(msg)))

    def fake_query_range(_query: str, start, end, step: str = "3600s") -> list[dict[str, Any]]:
        _ = (start, end, step)
        if _query.startswith("topk("):
            return [series_sample("dummy", labels={"queryid": "1"}, values=[(100, 0), (200, 0)])]
        # total is 1.0, union sums to 1.0 + 5e-7 => other = -5e-7 (below warning threshold)
        if "sum(increase(" in _query and "queryid" not in _query:
            return [series_sample("dummy", labels={}, values=[(100, 1.0), (200, 1.0)])]
        if "sum by (queryid)" in _query:
            return [series_sample("dummy", labels={"queryid": "1"}, values=[(100, 1.0000005), (200, 1.0000005)])]
        raise AssertionError(f"Unexpected query: {_query}")

    monkeypatch.setattr(generator, "query_range", fake_query_range)

    _, other, _ = generator._get_hourly_topk_pgss_data_sum2(
        cluster="local",
        node_name="node-1",
        db_name="db1",
        metric_name_a="metric_a",
        metric_name_b="metric_b",
        hours=2,
        step_s=3600,
        k=3,
    )

    assert other == pytest.approx([0.0, 0.0])
    assert warnings == []


