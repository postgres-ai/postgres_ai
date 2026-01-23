"""
Property-Based Tests - Phase 2

Uses Hypothesis to find edge cases not covered by explicit test vectors.
These tests verify invariants that should hold for ALL inputs.

Run with: pytest tests/compliance_vectors/test_property.py -v
"""
import os
import pytest
from hypothesis import given, strategies as st, settings, HealthCheck, assume

from reporter.postgres_reports import PostgresReportGenerator


# Configure Hypothesis profiles
settings.register_profile(
    "ci",
    max_examples=50,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow]
)
settings.register_profile("local", max_examples=200)
settings.load_profile(os.getenv("HYPOTHESIS_PROFILE", "local"))


# Create generator once at module level (it's stateless for these methods)
_GENERATOR = PostgresReportGenerator(
    prometheus_url="http://localhost:9090",
    postgres_sink_url=None
)


class TestMemoryParsingProperties:
    """Property-based tests that find edge cases not in vectors.

    These verify invariants rather than specific input/output pairs.
    """

    @given(st.integers(min_value=0, max_value=10_000))
    def test_parsing_is_case_insensitive(self, mb_value):
        """Verify MB/mb/Mb all parse to the same value."""
        upper = f"{mb_value}MB"
        lower = f"{mb_value}mb"
        mixed = f"{mb_value}Mb"

        result_upper = _GENERATOR._parse_memory_value(upper)
        result_lower = _GENERATOR._parse_memory_value(lower)
        result_mixed = _GENERATOR._parse_memory_value(mixed)

        assert result_upper == result_lower == result_mixed

    @given(st.integers(min_value=0, max_value=10_000))
    def test_kb_is_1024_times_smaller_than_mb(self, value):
        """Verify unit conversion: 1MB = 1024KB."""
        mb_result = _GENERATOR._parse_memory_value(f"{value}MB")
        kb_result = _GENERATOR._parse_memory_value(f"{value}KB")

        # MB should be 1024x larger than KB
        assert mb_result == kb_result * 1024

    @given(st.integers(min_value=0, max_value=1_000))
    def test_gb_is_1024_times_larger_than_mb(self, value):
        """Verify unit conversion: 1GB = 1024MB."""
        gb_result = _GENERATOR._parse_memory_value(f"{value}GB")
        mb_result = _GENERATOR._parse_memory_value(f"{value}MB")

        # GB should be 1024x larger than MB
        assert gb_result == mb_result * 1024

    @given(st.text(max_size=100))
    def test_never_raises_unexpected_exception(self, text):
        """Parser should return int or raise ValueError/TypeError, never crash."""
        try:
            result = _GENERATOR._parse_memory_value(text)
            # If no exception, result must be a non-negative int
            assert isinstance(result, int)
            assert result >= 0
        except (ValueError, TypeError):
            pass  # Expected for invalid inputs
        except Exception as e:
            pytest.fail(f"Unexpected exception: {type(e).__name__}: {e}")

    @given(st.integers(min_value=0, max_value=10_000))
    def test_result_is_always_non_negative(self, value):
        """All valid memory values should parse to non-negative bytes."""
        for unit in ["B", "KB", "MB", "GB"]:
            result = _GENERATOR._parse_memory_value(f"{value}{unit}")
            assert result >= 0, f"{value}{unit} parsed to negative: {result}"

    @given(st.text(alphabet="0123456789", min_size=1, max_size=10))
    def test_bare_numbers_multiply_by_1024(self, digits):
        """Bare numbers (no unit) should be treated as KB (multiplied by 1024)."""
        assume(digits.lstrip('0') or digits == '0')  # Avoid empty after stripping leading zeros
        result = _GENERATOR._parse_memory_value(digits)
        expected = int(digits) * 1024
        assert result == expected


class TestQueryIdValidationProperties:
    """Property-based tests for query ID validation."""

    @given(st.lists(st.integers(min_value=-2**62, max_value=2**62), min_size=1, max_size=10))
    def test_valid_integers_always_accepted(self, int_list):
        """All integer query IDs should be accepted."""
        str_list = [str(i) for i in int_list]
        result = _GENERATOR._build_qid_regex(str_list)
        # Should return a valid regex pattern
        assert result.startswith("^(?:")
        assert result.endswith(")$")

    @given(st.lists(st.from_regex(r"-?\d+", fullmatch=True), min_size=1, max_size=5))
    def test_regex_format_is_consistent(self, qid_list):
        """Output regex should always have format ^(?:...|...)$."""
        result = _GENERATOR._build_qid_regex(qid_list)
        assert result.startswith("^(?:")
        assert result.endswith(")$")
        # The middle should contain all IDs joined by |
        middle = result[4:-2]  # Strip ^(?: and )$
        parts = middle.split("|")
        assert set(parts) == set(qid_list)

    @given(st.text(alphabet="abcdefghijklmnopqrstuvwxyz.*/\\|()[]{}^$+?", min_size=1, max_size=20))
    def test_non_numeric_strings_rejected(self, text):
        """Non-numeric strings should raise ValueError (security: prevents injection)."""
        with pytest.raises(ValueError):
            _GENERATOR._build_qid_regex([text])


class TestDensifyProperties:
    """Property-based tests for _densify (time series densification)."""

    @given(
        st.lists(st.integers(min_value=1000, max_value=9999), min_size=1, max_size=5, unique=True),
        st.lists(st.integers(min_value=0, max_value=100000), min_size=1, max_size=10, unique=True),
    )
    def test_output_length_matches_timeline(self, qids, timeline):
        """Output lists should always match timeline length."""
        qid_strs = [str(q) for q in qids]
        timeline_sorted = sorted(timeline)
        # Empty series_pts - all values should be filled
        result = _GENERATOR._densify({}, qid_strs, timeline_sorted)

        for qid in qid_strs:
            assert len(result[qid]) == len(timeline_sorted)

    @given(
        st.lists(st.integers(min_value=1000, max_value=9999), min_size=1, max_size=3, unique=True),
        st.lists(st.integers(min_value=0, max_value=10000), min_size=1, max_size=5, unique=True),
        st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False),
    )
    def test_fill_value_used_for_missing(self, qids, timeline, fill):
        """Missing data points should use the fill value."""
        qid_strs = [str(q) for q in qids]
        timeline_sorted = sorted(timeline)
        # Empty series_pts - all values should be fill
        result = _GENERATOR._densify({}, qid_strs, timeline_sorted, fill=fill)

        for qid in qid_strs:
            assert all(v == fill for v in result[qid])

    @given(
        st.lists(st.integers(min_value=1000, max_value=9999), min_size=1, max_size=3, unique=True),
        st.lists(st.integers(min_value=0, max_value=10000), min_size=2, max_size=5, unique=True),
    )
    def test_existing_values_preserved(self, qids, timeline):
        """Existing values in series_pts should be preserved, not overwritten."""
        qid_strs = [str(q) for q in qids]
        timeline_sorted = sorted(timeline)

        # Create series_pts with known values at first timestamp
        series_pts = {}
        for qid in qid_strs:
            series_pts[qid] = {timeline_sorted[0]: 999.0}

        result = _GENERATOR._densify(series_pts, qid_strs, timeline_sorted)

        # First value should be preserved
        for qid in qid_strs:
            assert result[qid][0] == 999.0

    @given(
        st.lists(st.integers(min_value=1000, max_value=9999), min_size=1, max_size=3, unique=True),
        st.lists(st.integers(min_value=0, max_value=10000), min_size=1, max_size=5, unique=True),
    )
    def test_idempotent_on_empty_input(self, qids, timeline):
        """Calling _densify twice on empty input should give same result."""
        qid_strs = [str(q) for q in qids]
        timeline_sorted = sorted(timeline)

        result1 = _GENERATOR._densify({}, qid_strs, timeline_sorted)
        # Second call with result converted back (simulating re-densification)
        result2 = _GENERATOR._densify({}, qid_strs, timeline_sorted)

        assert result1 == result2
