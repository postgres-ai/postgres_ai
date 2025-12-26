from __future__ import annotations

from typing import Any

import pytest

from reporter.postgres_reports import PostgresReportGenerator
from reporter.report_schemas import validate_report


@pytest.fixture(name="generator")
def fixture_generator() -> PostgresReportGenerator:
    return PostgresReportGenerator(
        prometheus_url="http://prom.test",
        postgres_sink_url="",
    )


@pytest.fixture(name="fixed_pg_version")
def fixture_fixed_pg_version() -> dict[str, str]:
    return {
        "version": "15.3",
        "server_version_num": "150003",
        "server_major_ver": "15",
        "server_minor_ver": "3",
    }


def _stub_hourly_topk(metric_to_payload: dict[str, tuple[dict[str, list[float]], list[float], list[int]]]):
    def _stub(
        cluster: str,
        node_name: str,
        db_name: str,
        metric_name: str = "pgwatch_pg_stat_statements_calls",
        hours: int = 24,
        step_s: int = 3600,
        k: int = 3,
    ):
        _ = (cluster, node_name, db_name, hours, step_s, k)
        if metric_name not in metric_to_payload:
            raise AssertionError(f"Unexpected metric_name: {metric_name}")
        return metric_to_payload[metric_name]

    return _stub


@pytest.mark.unit
def test_schema_k004(monkeypatch: pytest.MonkeyPatch, generator: PostgresReportGenerator, fixed_pg_version) -> None:
    monkeypatch.setattr(generator, "_get_postgres_version_info", lambda *args, **kwargs: fixed_pg_version)
    monkeypatch.setattr(generator, "get_all_databases", lambda *args, **kwargs: ["db1"])
    monkeypatch.setattr(
        generator,
        "_get_hourly_topk_pgss_data",
        _stub_hourly_topk(
            {"pgwatch_pg_stat_statements_temp_bytes_written": ({"1": [1.0]}, [0.0], [100])}
        ),
    )
    report = generator.generate_k004_temp_bytes_report("local", "node-1", time_range_minutes=60, limit=50)
    validate_report(report)


@pytest.mark.unit
def test_schema_k005(monkeypatch: pytest.MonkeyPatch, generator: PostgresReportGenerator, fixed_pg_version) -> None:
    monkeypatch.setattr(generator, "_get_postgres_version_info", lambda *args, **kwargs: fixed_pg_version)
    monkeypatch.setattr(generator, "get_all_databases", lambda *args, **kwargs: ["db1"])
    monkeypatch.setattr(
        generator,
        "_get_hourly_topk_pgss_data",
        _stub_hourly_topk({"pgwatch_pg_stat_statements_wal_bytes": ({"1": [1.0]}, [0.0], [100])}),
    )
    report = generator.generate_k005_wal_bytes_report("local", "node-1", time_range_minutes=60, limit=50)
    validate_report(report)


@pytest.mark.unit
def test_schema_k006(monkeypatch: pytest.MonkeyPatch, generator: PostgresReportGenerator, fixed_pg_version) -> None:
    monkeypatch.setattr(generator, "_get_postgres_version_info", lambda *args, **kwargs: fixed_pg_version)
    monkeypatch.setattr(generator, "get_all_databases", lambda *args, **kwargs: ["db1"])
    monkeypatch.setattr(
        generator,
        "_get_hourly_topk_pgss_data",
        _stub_hourly_topk(
            {"pgwatch_pg_stat_statements_shared_bytes_read_total": ({"1": [1.0]}, [0.0], [100])}
        ),
    )
    report = generator.generate_k006_shared_read_report("local", "node-1", time_range_minutes=60, limit=50)
    validate_report(report)


@pytest.mark.unit
def test_schema_k007(monkeypatch: pytest.MonkeyPatch, generator: PostgresReportGenerator, fixed_pg_version) -> None:
    monkeypatch.setattr(generator, "_get_postgres_version_info", lambda *args, **kwargs: fixed_pg_version)
    monkeypatch.setattr(generator, "get_all_databases", lambda *args, **kwargs: ["db1"])
    monkeypatch.setattr(
        generator,
        "_get_hourly_topk_pgss_data",
        _stub_hourly_topk(
            {"pgwatch_pg_stat_statements_shared_bytes_hit_total": ({"1": [1.0]}, [0.0], [100])}
        ),
    )
    report = generator.generate_k007_shared_hit_report("local", "node-1", time_range_minutes=60, limit=50)
    validate_report(report)


@pytest.mark.unit
def test_schema_m001(monkeypatch: pytest.MonkeyPatch, generator: PostgresReportGenerator, fixed_pg_version) -> None:
    monkeypatch.setattr(generator, "_get_postgres_version_info", lambda *args, **kwargs: fixed_pg_version)
    monkeypatch.setattr(generator, "get_all_databases", lambda *args, **kwargs: ["db1"])
    monkeypatch.setattr(
        generator,
        "_get_hourly_topk_pgss_data",
        _stub_hourly_topk(
            {
                "pgwatch_pg_stat_statements_exec_time_total": ({"1": [10.0]}, [0.0], [100]),
                "pgwatch_pg_stat_statements_calls": ({"1": [1.0]}, [0.0], [100]),
            }
        ),
    )
    report = generator.generate_m001_mean_time_report("local", "node-1", time_range_minutes=60, limit=50)
    validate_report(report)


@pytest.mark.unit
def test_schema_m002(monkeypatch: pytest.MonkeyPatch, generator: PostgresReportGenerator, fixed_pg_version) -> None:
    monkeypatch.setattr(generator, "_get_postgres_version_info", lambda *args, **kwargs: fixed_pg_version)
    monkeypatch.setattr(generator, "get_all_databases", lambda *args, **kwargs: ["db1"])
    monkeypatch.setattr(
        generator,
        "_get_hourly_topk_pgss_data",
        _stub_hourly_topk({"pgwatch_pg_stat_statements_rows": ({"1": [10.0]}, [0.0], [100])}),
    )
    report = generator.generate_m002_rows_report("local", "node-1", time_range_minutes=60, limit=50)
    validate_report(report)


@pytest.mark.unit
def test_schema_m003(monkeypatch: pytest.MonkeyPatch, generator: PostgresReportGenerator, fixed_pg_version) -> None:
    monkeypatch.setattr(generator, "_get_postgres_version_info", lambda *args, **kwargs: fixed_pg_version)
    monkeypatch.setattr(generator, "get_all_databases", lambda *args, **kwargs: ["db1"])
    monkeypatch.setattr(
        generator,
        "_get_hourly_topk_pgss_data",
        _stub_hourly_topk(
            {
                "pgwatch_pg_stat_statements_block_read_total": ({"1": [10.0]}, [0.0], [100]),
                "pgwatch_pg_stat_statements_block_write_total": ({"1": [5.0]}, [0.0], [100]),
            }
        ),
    )
    report = generator.generate_m003_io_time_report("local", "node-1", time_range_minutes=60, limit=50)
    validate_report(report)


@pytest.mark.unit
def test_schema_n001(monkeypatch: pytest.MonkeyPatch, generator: PostgresReportGenerator, fixed_pg_version) -> None:
    monkeypatch.setattr(generator, "_get_postgres_version_info", lambda *args, **kwargs: fixed_pg_version)
    monkeypatch.setattr(generator, "get_all_databases", lambda *args, **kwargs: ["db1"])
    monkeypatch.setattr(generator, "_floor_hour", lambda *_: 7200)

    def fake_query_range(_query: str, start, end, step: str = "3600s") -> list[dict[str, Any]]:
        _ = (start, end, step)
        return [
            {
                "metric": {
                    "wait_event_type": "IO",
                    "wait_event": "DataFileRead",
                    "query_id": "123",
                },
                "values": [[0, "1"], [3600, "2"], [7200, "0"]],
            }
        ]

    monkeypatch.setattr(generator, "query_range", fake_query_range)
    report = generator.generate_n001_wait_events_report("local", "node-1", hours=3)
    validate_report(report)


