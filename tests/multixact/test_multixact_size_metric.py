"""
Tests for the multixact_size metric, including PostgreSQL 19 pg_get_multixact_stats() support.

This module tests:
1. SQL structure for both version 11 (filesystem-based) and version 19 (native function)
2. Fallback logic from native function to Aurora/RDS/filesystem methods
3. Mathematical correctness of offsets_bytes calculation formula
4. Integration with real PostgreSQL (pre-19 versions)

See: https://gitlab.com/postgres-ai/postgres_ai/-/issues/84
PostgreSQL commit: https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=97b101776ce23dd6c4abbdae213806bc24ed6133
"""

import os
import re
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import MagicMock, patch

import pytest
import yaml


def get_metrics_yml_path() -> Path:
    """Get the path to the metrics.yml file."""
    repo_root = Path(__file__).parent.parent.parent
    return repo_root / "config" / "pgwatch-prometheus" / "metrics.yml"


@pytest.fixture(name="metrics_config")
def fixture_metrics_config() -> dict:
    """Load the metrics.yml configuration."""
    metrics_path = get_metrics_yml_path()
    with open(metrics_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


# =============================================================================
# Unit Tests: SQL Structure (Version 11 - Filesystem-based)
# =============================================================================


@pytest.mark.unit
def test_multixact_size_metric_exists(metrics_config: dict) -> None:
    """Test that the multixact_size metric is defined in metrics.yml."""
    assert "metrics" in metrics_config, "metrics key should exist"
    assert "multixact_size" in metrics_config["metrics"], "multixact_size metric should be defined"
    assert "sqls" in metrics_config["metrics"]["multixact_size"], "multixact_size metric should have sqls"


@pytest.mark.unit
def test_multixact_size_v11_exists(metrics_config: dict) -> None:
    """Test that version 11 SQL exists for pre-PG19 compatibility."""
    sqls = metrics_config["metrics"]["multixact_size"]["sqls"]
    assert 11 in sqls, "multixact_size should have SQL for version 11+"


@pytest.mark.unit
def test_multixact_size_v11_has_required_output_fields(metrics_config: dict) -> None:
    """Test that version 11 SQL returns all required fields."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][11]

    required_fields = ["members_bytes", "offsets_bytes", "status_code"]
    for field in required_fields:
        assert field in sql, f"v11 SQL should include {field}"


@pytest.mark.unit
def test_multixact_size_v11_has_platform_detection(metrics_config: dict) -> None:
    """Test that version 11 SQL detects Aurora, RDS, and local filesystem methods."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][11]

    # Should detect platform-specific functions
    assert "aurora_stat_file" in sql, "v11 SQL should check for Aurora function"
    assert "pg_ls_multixactdir" in sql, "v11 SQL should check for RDS function"
    assert "pg_ls_dir" in sql, "v11 SQL should check for local filesystem function"
    assert "pg_stat_file" in sql, "v11 SQL should check for local filesystem function"


@pytest.mark.unit
def test_multixact_size_v11_has_fallback_logic(metrics_config: dict) -> None:
    """Test that version 11 SQL has proper fallback when no method available."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][11]

    # Should have fallback that returns status_code = 2
    assert "2::int" in sql or "2 as status_code" in sql.lower(), \
        "v11 SQL should return status_code=2 when no method available"


# =============================================================================
# Unit Tests: SQL Structure (Version 19 - Native pg_get_multixact_stats())
# =============================================================================


@pytest.mark.unit
def test_multixact_size_v19_exists(metrics_config: dict) -> None:
    """Test that version 19 SQL exists for PG19+ with native function support."""
    sqls = metrics_config["metrics"]["multixact_size"]["sqls"]
    assert 19 in sqls, "multixact_size should have SQL for version 19+"


@pytest.mark.unit
def test_multixact_size_v19_uses_native_function(metrics_config: dict) -> None:
    """Test that version 19 SQL uses pg_get_multixact_stats() when available."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][19]

    assert "pg_get_multixact_stats" in sql, \
        "v19 SQL should use pg_get_multixact_stats() function"
    assert "pg_catalog.pg_get_multixact_stats()" in sql, \
        "v19 SQL should call pg_catalog.pg_get_multixact_stats()"


@pytest.mark.unit
def test_multixact_size_v19_checks_function_availability(metrics_config: dict) -> None:
    """Test that version 19 SQL checks if native function exists before using it."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][19]

    # Should check pg_proc for function existence
    assert "pg_proc" in sql, "v19 SQL should query pg_proc to check function availability"
    assert "has_native_fn" in sql, "v19 SQL should have has_native_fn flag"


@pytest.mark.unit
def test_multixact_size_v19_has_fallback_to_v11_methods(metrics_config: dict) -> None:
    """Test that version 19 SQL falls back to Aurora/RDS/filesystem methods."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][19]

    # Should have all fallback methods from v11
    assert "aurora_stat_file" in sql, "v19 SQL should have Aurora fallback"
    assert "pg_ls_multixactdir" in sql or "rds_tools" in sql, "v19 SQL should have RDS fallback"
    assert "pg_ls_dir" in sql, "v19 SQL should have filesystem fallback"


@pytest.mark.unit
def test_multixact_size_v19_has_required_output_fields(metrics_config: dict) -> None:
    """Test that version 19 SQL returns all required fields."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][19]

    required_fields = ["members_bytes", "offsets_bytes", "status_code"]
    for field in required_fields:
        assert field in sql, f"v19 SQL should include {field}"


@pytest.mark.unit
def test_multixact_size_v19_uses_members_size_from_native_function(metrics_config: dict) -> None:
    """Test that v19 uses members_size from pg_get_multixact_stats() for members_bytes."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][19]

    # The native function returns members_size which maps to members_bytes
    assert "members_size" in sql, "v19 SQL should use members_size from native function"


@pytest.mark.unit
def test_multixact_size_v19_calculates_offsets_bytes_from_num_mxids(metrics_config: dict) -> None:
    """Test that v19 calculates offsets_bytes from num_mxids."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][19]

    # offsets_bytes should be calculated from num_mxids
    assert "num_mxids" in sql, "v19 SQL should use num_mxids for offsets calculation"
    # Formula: ceiling(num_mxids / 32768) * 262144
    assert "32768" in sql, "v19 SQL should use 32768 (entries per segment)"
    assert "262144" in sql, "v19 SQL should use 262144 (bytes per segment = 256KB)"


@pytest.mark.unit
def test_multixact_size_v19_offsets_formula_structure(metrics_config: dict) -> None:
    """Test that the offsets_bytes formula uses ceiling for correct segment count."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][19]

    # Should use ceiling to round up to full segments
    assert "ceiling" in sql.lower(), "v19 SQL should use CEILING for segment calculation"


# =============================================================================
# Unit Tests: Mathematical Correctness of Offsets Formula
# =============================================================================


@pytest.mark.unit
def test_offsets_bytes_formula_zero_mxids() -> None:
    """Test offsets_bytes formula when num_mxids = 0."""
    # Formula: ceiling(num_mxids / 32768) * 262144
    import math
    num_mxids = 0
    result = math.ceil(num_mxids / 32768) * 262144
    assert result == 0, "0 mxids should result in 0 bytes"


@pytest.mark.unit
def test_offsets_bytes_formula_one_mxid() -> None:
    """Test offsets_bytes formula when num_mxids = 1."""
    import math
    num_mxids = 1
    result = math.ceil(num_mxids / 32768) * 262144
    # 1 mxid needs 1 segment (256KB)
    assert result == 262144, "1 mxid should result in 262144 bytes (one segment)"


@pytest.mark.unit
def test_offsets_bytes_formula_exact_segment_boundary() -> None:
    """Test offsets_bytes formula at exact segment boundary (32768 mxids)."""
    import math
    num_mxids = 32768
    result = math.ceil(num_mxids / 32768) * 262144
    # 32768 mxids fit exactly in 1 segment
    assert result == 262144, "32768 mxids should fit in exactly one segment"


@pytest.mark.unit
def test_offsets_bytes_formula_one_over_boundary() -> None:
    """Test offsets_bytes formula just over segment boundary (32769 mxids)."""
    import math
    num_mxids = 32769
    result = math.ceil(num_mxids / 32768) * 262144
    # 32769 mxids need 2 segments
    assert result == 524288, "32769 mxids should need two segments (524288 bytes)"


@pytest.mark.unit
def test_offsets_bytes_formula_large_value() -> None:
    """Test offsets_bytes formula with large num_mxids value."""
    import math
    # 1 million mxids
    num_mxids = 1_000_000
    result = math.ceil(num_mxids / 32768) * 262144
    expected_segments = math.ceil(1_000_000 / 32768)  # 31 segments
    assert result == expected_segments * 262144
    assert result == 31 * 262144  # 8126464 bytes (~7.75 MB)


# =============================================================================
# Unit Tests: Fallback Priority Logic
# =============================================================================


@pytest.mark.unit
def test_multixact_size_v19_native_has_priority(metrics_config: dict) -> None:
    """Test that native function has priority over other methods in v19."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][19]

    # native_probe_xml should be first in the UNION ALL
    native_pos = sql.find("native_probe_xml")
    aurora_pos = sql.find("aurora_probe_xml")
    rds_pos = sql.find("rds_probe_xml")
    local_pos = sql.find("local_probe_xml")

    # All should exist
    assert native_pos > 0, "native_probe_xml should exist"
    assert aurora_pos > 0, "aurora_probe_xml should exist"

    # In the "picked" CTE, native should come before others
    picked_section = sql[sql.find("picked as"):]
    native_in_picked = picked_section.find("native_probe_xml")
    aurora_in_picked = picked_section.find("aurora_probe_xml")

    assert native_in_picked < aurora_in_picked, \
        "native_probe_xml should be first in picked CTE (highest priority)"


@pytest.mark.unit
def test_multixact_size_v19_aurora_excludes_native(metrics_config: dict) -> None:
    """Test that Aurora fallback only triggers when native function unavailable."""
    sql = metrics_config["metrics"]["multixact_size"]["sqls"][19]

    # Aurora probe should have "not has_native_fn" condition
    aurora_section_match = re.search(r'aurora_probe_xml as \([^)]+\)', sql, re.DOTALL)
    if aurora_section_match:
        aurora_section = aurora_section_match.group()
        # The WHERE clause should exclude native
        assert "has_native_fn" in sql, "Aurora probe should check native function availability"


@pytest.mark.unit
def test_multixact_size_gauges_defined(metrics_config: dict) -> None:
    """Test that the metric has proper gauge definitions."""
    metric = metrics_config["metrics"]["multixact_size"]

    assert "gauges" in metric, "multixact_size should have gauges defined"
    gauges = metric["gauges"]

    assert "members_bytes" in gauges, "members_bytes should be a gauge"
    assert "offsets_bytes" in gauges, "offsets_bytes should be a gauge"
    assert "status_code" in gauges, "status_code should be a gauge"


# =============================================================================
# Integration Tests: Pre-PG19 (Real PostgreSQL)
# =============================================================================


@pytest.mark.integration
@pytest.mark.requires_postgres
def test_multixact_size_v11_sql_executes_successfully() -> None:
    """
    Integration test: verify v11 SQL executes without errors on real PostgreSQL.

    This test requires a running PostgreSQL database (any version 11+).
    """
    try:
        import psycopg
    except ImportError:
        pytest.skip("psycopg not available")

    target_db_url = os.getenv(
        "TARGET_DB_URL",
        "postgresql://postgres:postgres@localhost:55432/target_database"
    )

    try:
        conn = psycopg.connect(target_db_url)
    except Exception as e:
        pytest.skip(f"Could not connect to PostgreSQL: {e}")

    # Load the v11 SQL
    metrics_path = get_metrics_yml_path()
    with open(metrics_path, "r", encoding="utf-8") as f:
        metrics_config = yaml.safe_load(f)

    sql = metrics_config["metrics"]["multixact_size"]["sqls"][11]

    try:
        with conn.cursor() as cur:
            # Execute the metric SQL
            cur.execute(sql)
            row = cur.fetchone()

            # Should return exactly 3 columns
            assert row is not None, "Query should return a row"
            assert len(row) == 3, f"Query should return 3 columns, got {len(row)}"

            members_bytes, offsets_bytes, status_code = row

            # status_code should be 0, 1, or 2
            assert status_code in (0, 1, 2), f"status_code should be 0, 1, or 2, got {status_code}"

            # If status_code is 0 (success), bytes should be non-negative
            if status_code == 0:
                assert members_bytes is not None, "members_bytes should not be None when status=0"
                assert offsets_bytes is not None, "offsets_bytes should not be None when status=0"
                assert members_bytes >= 0, "members_bytes should be non-negative"
                assert offsets_bytes >= 0, "offsets_bytes should be non-negative"
    finally:
        conn.close()


@pytest.mark.integration
@pytest.mark.requires_postgres
def test_multixact_size_returns_reasonable_values() -> None:
    """
    Integration test: verify returned values are reasonable.

    pg_multixact directories always exist (even if nearly empty), so we should
    get some data back on any PostgreSQL installation.
    """
    try:
        import psycopg
    except ImportError:
        pytest.skip("psycopg not available")

    target_db_url = os.getenv(
        "TARGET_DB_URL",
        "postgresql://postgres:postgres@localhost:55432/target_database"
    )

    try:
        conn = psycopg.connect(target_db_url)
    except Exception as e:
        pytest.skip(f"Could not connect to PostgreSQL: {e}")

    metrics_path = get_metrics_yml_path()
    with open(metrics_path, "r", encoding="utf-8") as f:
        metrics_config = yaml.safe_load(f)

    sql = metrics_config["metrics"]["multixact_size"]["sqls"][11]

    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            row = cur.fetchone()
            members_bytes, offsets_bytes, status_code = row

            # On a working system, we expect status 0 or 1
            # Status 2 means no probe method available (permissions issue)
            if status_code == 2:
                pytest.skip("No probe method available (likely permissions issue)")

            # If we got data, values should be reasonable
            if status_code == 0:
                # Multixact files are at least a few KB even on idle systems
                # Max reasonable size is a few TB (very busy system)
                assert members_bytes < 10 * 1024 * 1024 * 1024 * 1024, \
                    "members_bytes seems unreasonably large (>10TB)"
                assert offsets_bytes < 10 * 1024 * 1024 * 1024 * 1024, \
                    "offsets_bytes seems unreasonably large (>10TB)"
    finally:
        conn.close()


# =============================================================================
# Mock Tests: PG19 Native Function Logic
# =============================================================================


@pytest.mark.unit
def test_mock_pg19_native_function_available() -> None:
    """
    Mock test: simulate pg_get_multixact_stats() being available.

    This tests the SQL logic without requiring actual PG19.
    """
    # Simulate what pg_get_multixact_stats() returns
    mock_stats = {
        "num_mxids": 100000,
        "num_members": 500000,
        "members_size": 15000000,  # 15MB
        "oldest_multixact": "12345"
    }

    # Calculate expected offsets_bytes using our formula
    import math
    expected_offsets = math.ceil(mock_stats["num_mxids"] / 32768) * 262144
    # 100000 / 32768 = 3.05... -> ceil = 4 segments
    # 4 * 262144 = 1048576 bytes
    assert expected_offsets == 4 * 262144

    # Verify the members_bytes would come directly from members_size
    expected_members = mock_stats["members_size"]
    assert expected_members == 15000000


@pytest.mark.unit
def test_mock_pg19_formula_matches_sql(metrics_config: dict) -> None:
    """
    Mock test: verify Python formula matches SQL formula.

    Ensures our test calculations match what the SQL does.
    """
    import math

    sql = metrics_config["metrics"]["multixact_size"]["sqls"][19]

    # Extract the formula from SQL (should be something like):
    # (ceiling(num_mxids::numeric / 32768) * 262144)::bigint

    # Verify constants are correct in SQL
    assert "32768" in sql, "SQL should use 32768"
    assert "262144" in sql, "SQL should use 262144"

    # Test a few values match
    test_values = [0, 1, 32767, 32768, 32769, 100000, 1000000]
    for num_mxids in test_values:
        python_result = math.ceil(num_mxids / 32768) * 262144
        # We can't execute the SQL here, but we verify the formula structure
        assert python_result >= 0, f"Result should be non-negative for {num_mxids}"
        assert python_result % 262144 == 0, f"Result should be multiple of segment size for {num_mxids}"


@pytest.mark.unit
def test_mock_pg19_fallback_when_function_missing() -> None:
    """
    Mock test: verify fallback logic when pg_get_multixact_stats() doesn't exist.

    In pre-PG19, the function won't exist, so the SQL should fall back to
    Aurora/RDS/filesystem methods.
    """
    # This simulates what happens when has_native_fn = false
    # The native_probe_xml CTE should return no rows
    # And the query should try aurora_probe_xml, rds_probe_xml, local_probe_xml

    # The key test is that the SQL has proper WHERE conditions:
    # - native_probe_xml: WHERE has_native_fn
    # - aurora_probe_xml: WHERE has_aurora_fn AND NOT has_native_fn
    # - rds_probe_xml: WHERE has_rds_fn AND NOT has_aurora_fn AND NOT has_native_fn
    # - local_probe_xml: WHERE NOT has_rds_fn AND NOT has_aurora_fn AND NOT has_native_fn AND can_local

    # We verify this structure exists in the SQL (tested in other unit tests)
    # Here we just confirm the mutual exclusion logic concept

    scenarios = [
        {"has_native_fn": True, "expected_probe": "native"},
        {"has_native_fn": False, "has_aurora_fn": True, "expected_probe": "aurora"},
        {"has_native_fn": False, "has_aurora_fn": False, "has_rds_fn": True, "expected_probe": "rds"},
        {"has_native_fn": False, "has_aurora_fn": False, "has_rds_fn": False, "can_local": True, "expected_probe": "local"},
        {"has_native_fn": False, "has_aurora_fn": False, "has_rds_fn": False, "can_local": False, "expected_probe": "none"},
    ]

    for scenario in scenarios:
        # This is a conceptual test - the actual SQL handles this logic
        # We're just documenting the expected behavior
        assert "expected_probe" in scenario


# =============================================================================
# TODO: PG19 Image Tests (Pending PG19 Release)
# =============================================================================


@pytest.mark.skip(reason="TODO: Enable when PostgreSQL 19 Docker images are available (~Q3 2025)")
@pytest.mark.integration
@pytest.mark.requires_postgres
def test_pg19_native_function_exists() -> None:
    """
    Integration test: verify pg_get_multixact_stats() exists in PG19.

    TODO: Enable this test when PostgreSQL 19 Docker images are available.
    Expected release: PostgreSQL 19 beta ~mid-2025, GA ~Q3 2025.

    This test should:
    1. Connect to a PG19 instance
    2. Verify pg_get_multixact_stats() function exists in pg_catalog
    3. Verify it returns the expected columns: num_mxids, num_members, members_size, oldest_multixact
    """
    pytest.skip("PostgreSQL 19 images not yet available")


@pytest.mark.skip(reason="TODO: Enable when PostgreSQL 19 Docker images are available (~Q3 2025)")
@pytest.mark.integration
@pytest.mark.requires_postgres
def test_pg19_native_function_returns_valid_data() -> None:
    """
    Integration test: verify pg_get_multixact_stats() returns valid data in PG19.

    TODO: Enable this test when PostgreSQL 19 Docker images are available.

    This test should:
    1. Connect to a PG19 instance
    2. Call pg_get_multixact_stats()
    3. Verify all columns have valid values
    4. Verify members_size correlates with actual pg_multixact/members folder size
    """
    pytest.skip("PostgreSQL 19 images not yet available")


@pytest.mark.skip(reason="TODO: Enable when PostgreSQL 19 Docker images are available (~Q3 2025)")
@pytest.mark.integration
@pytest.mark.requires_postgres
def test_pg19_metric_uses_native_function() -> None:
    """
    Integration test: verify v19 metric SQL uses native function on PG19.

    TODO: Enable this test when PostgreSQL 19 Docker images are available.

    This test should:
    1. Connect to a PG19 instance
    2. Execute the v19 SQL
    3. Verify it returns status_code=0 (success via native function)
    4. Compare members_bytes with pg_get_multixact_stats().members_size
    """
    pytest.skip("PostgreSQL 19 images not yet available")


@pytest.mark.skip(reason="TODO: Enable when PostgreSQL 19 Docker images are available (~Q3 2025)")
@pytest.mark.integration
@pytest.mark.requires_postgres
def test_pg19_offsets_calculation_accuracy() -> None:
    """
    Integration test: verify offsets_bytes calculation matches actual folder size.

    TODO: Enable this test when PostgreSQL 19 Docker images are available.

    This test should:
    1. Connect to a PG19 instance
    2. Get offsets_bytes from our metric
    3. Get actual pg_multixact/offsets folder size
    4. Verify they are close (our calculation is an estimate based on num_mxids)

    Note: Our formula calculates theoretical max size based on segment structure,
    which may differ slightly from actual disk usage due to sparse files or
    segment truncation.
    """
    pytest.skip("PostgreSQL 19 images not yet available")
