from typing import Callable

import pytest


def pytest_addoption(parser: pytest.Parser) -> None:
    """Add a flag for enabling integration tests that require services."""
    parser.addoption(
        "--run-integration",
        action="store_true",
        default=False,
        help="Run tests marked as integration/requires_postgres.",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Skip integration tests unless --run-integration is given."""
    if config.getoption("--run-integration"):
        return

    skip_marker = pytest.mark.skip(reason="integration tests require --run-integration")
    for item in items:
        if "integration" in item.keywords or "requires_postgres" in item.keywords:
            item.add_marker(skip_marker)


@pytest.fixture(name="prom_result")
def fixture_prom_result() -> Callable[[list[dict] | None, str], dict]:
    """Build a Prometheus-like payload for the happy-path tests."""

    def _builder(rows: list[dict] | None = None, status: str = "success") -> dict:
        return {
            "status": status,
            "data": {
                "result": rows or [],
            },
        }

    return _builder


@pytest.fixture(name="series_sample")
def fixture_series_sample() -> Callable[[str, dict | None, list[tuple[float | int, float | int | str]] | None], dict]:
    """Create metric entries (metric metadata + values array) for query_range tests."""

    def _builder(
        metric_name: str,
        labels: dict | None = None,
        values: list[tuple[float | int, float | int | str]] | None = None,
    ) -> dict:
        labels = labels or {}
        values = values or []
        return {
            "metric": {"__name__": metric_name, **labels},
            "values": [[ts, str(val)] for ts, val in values],
        }

    return _builder
