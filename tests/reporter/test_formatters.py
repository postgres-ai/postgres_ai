import pytest

from reporter.postgres_reports import PostgresReportGenerator


@pytest.fixture(name="generator")
def fixture_generator() -> PostgresReportGenerator:
    return PostgresReportGenerator(prometheus_url="http://test", postgres_sink_url="")


@pytest.mark.unit
@pytest.mark.parametrize(
    "value,expected",
    [
        (0, "0 B"),
        (1, "1.00 B"),
        (1024, "1.00 KiB"),
        (10 * 1024, "10.0 KiB"),
        (1048576, "1.00 MiB"),
        (5 * 1024 ** 3, "5.00 GiB"),
    ],
)
def test_format_bytes(generator: PostgresReportGenerator, value: int, expected: str) -> None:
    assert generator.format_bytes(value) == expected


@pytest.mark.unit
@pytest.mark.parametrize(
    "name,value,unit,expected",
    [
        ("shared_buffers", "128", "8kB", "1 MiB"),
        ("work_mem", "512", "", "512 KiB"),
        ("log_min_duration_statement", "2000", "ms", "2 s"),
        ("log_min_duration_statement", "500", "ms", "500 ms"),
        ("autovacuum_naptime", "120", "", "2 min"),
        ("autovacuum", "on", "", "on"),
        ("autovacuum", "OFF", "", "off"),
    ],
)
def test_format_setting_value(
    generator: PostgresReportGenerator,
    name: str,
    value: str,
    unit: str,
    expected: str,
) -> None:
    assert generator.format_setting_value(name, value, unit) == expected


@pytest.mark.unit
def test_get_cluster_metric_metadata(generator: PostgresReportGenerator) -> None:
    assert generator.get_cluster_metric_unit("active_connections") == "connections"
    assert generator.get_cluster_metric_description(
        "active_connections"
    ).startswith("Number of active")
    assert generator.get_cluster_metric_unit("unknown") == ""


@pytest.mark.unit
def test_get_setting_unit_and_category(generator: PostgresReportGenerator) -> None:
    assert generator.get_setting_unit("shared_buffers") == "8kB"
    assert generator.get_setting_category("shared_buffers") == "Memory"
    assert generator.get_setting_unit("nonexistent") == ""
    assert generator.get_setting_category("nonexistent") == "Other"


@pytest.mark.unit
def test_format_report_data_structure(generator: PostgresReportGenerator) -> None:
    host = "db-1"
    payload = generator.format_report_data("A002", {"foo": "bar"}, host)

    assert payload["checkId"] == "A002"
    # Newer reporter returns a 'nodes' structure instead of legacy 'hosts'.
    assert payload["nodes"]["primary"] == host
    assert payload["results"][host]["data"] == {"foo": "bar"}
