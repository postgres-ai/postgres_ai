"""
Compliance Vector Tests - Phase 0 Spike

This module validates that Python implementations match compliance vector specifications.
These vectors serve as the "Rosetta Stone" for the TypeScript migration - ensuring both
implementations behave identically for documented inputs.

Run with: pytest tests/compliance_vectors/test_compliance.py -v
"""
import json
import pytest
from pathlib import Path

# Import the class under test
from reporter.postgres_reports import PostgresReportGenerator

VECTORS_DIR = Path(__file__).parent


def load_vectors(name: str) -> dict:
    """Load vectors from JSON file, caching at module level."""
    return json.loads((VECTORS_DIR / f"{name}.json").read_text())


def get_valid_cases(vectors: dict) -> list:
    """Get all cases expecting success (have 'expected' field)."""
    cases = list(vectors.get("valid_cases", []))
    for group_cases in vectors.get("case_groups", {}).values():
        cases.extend(c for c in group_cases if "expected" in c)
    return cases


def get_invalid_cases(vectors: dict) -> list:
    """Get all cases expecting failure (have 'error_code' field)."""
    cases = list(vectors.get("invalid_cases", []))
    for group_cases in vectors.get("case_groups", {}).values():
        cases.extend(c for c in group_cases if "error_code" in c)
    return cases


# Load vectors at module level for parametrize
MEMORY_VECTORS = load_vectors("memory_parsing")
QUERY_ID_VECTORS = load_vectors("query_id_validation")


class TestVectorSchemaValid:
    """Validate all vector files against schema."""

    def test_vectors_match_schema(self):
        """All vector files must conform to schema.json"""
        import jsonschema
        schema = json.loads((VECTORS_DIR / "schema.json").read_text())
        for vector_file in VECTORS_DIR.glob("*.json"):
            if vector_file.name == "schema.json":
                continue
            data = json.loads(vector_file.read_text())
            jsonschema.validate(data, schema)

    def test_memory_vectors_have_required_fields(self):
        """memory_parsing.json must have valid_cases or case_groups"""
        data = MEMORY_VECTORS
        has_valid = bool(data.get("valid_cases"))
        has_groups = bool(data.get("case_groups"))
        assert has_valid or has_groups, "memory_parsing.json must have valid_cases or case_groups"


class TestMemoryParsingCompliance:
    """Tests loaded from compliance_vectors/memory_parsing.json

    These tests verify that _parse_memory_value behaves as documented.
    The actual Python behavior returns 0 for invalid inputs (no exceptions).
    """

    @pytest.fixture
    def generator(self):
        """Create a PostgresReportGenerator instance for testing."""
        # Use dummy URLs since we're only testing the parsing method
        return PostgresReportGenerator(
            prometheus_url="http://localhost:9090",
            postgres_sink_url=None
        )

    @pytest.mark.parametrize("case", get_valid_cases(MEMORY_VECTORS), ids=lambda c: c["id"])
    def test_valid_cases(self, generator, case):
        """Test that valid inputs produce expected outputs."""
        if case.get("python_skip"):
            pytest.skip(f"Skipped for Python: {case.get('note', '')}")

        result = generator._parse_memory_value(case["input"])
        assert result == case["expected"], f"Input: {case['input']!r}, Expected: {case['expected']}, Got: {result}"
        # Outcome should be success for valid cases
        assert case["outcome"] == "success"

    @pytest.mark.parametrize(
        "case",
        get_invalid_cases(MEMORY_VECTORS),
        ids=lambda c: c["id"] if isinstance(c, dict) else "empty"
    )
    def test_invalid_cases(self, generator, case):
        """Test that invalid inputs produce documented error behavior.

        These test cases document inputs that raise exceptions in Python.
        """
        if case.get("python_skip"):
            pytest.skip(f"Skipped for Python: {case.get('note', '')}")

        # Assert outcome is failure
        assert case["outcome"] == "failure"

        # Map error codes to Python exceptions
        error_map = {
            "ERR_EMPTY_INPUT": ValueError,
            "ERR_NULL_INPUT": TypeError,
            "ERR_INVALID_FORMAT": ValueError,
            "ERR_NEGATIVE_VALUE": ValueError,
            "ERR_UNKNOWN_UNIT": ValueError,
        }
        error_type = error_map.get(case["error_code"], Exception)
        with pytest.raises(error_type):
            generator._parse_memory_value(case["input"])


class TestQueryIdValidationCompliance:
    """Tests loaded from compliance_vectors/query_id_validation.json

    These tests verify that _build_qid_regex validates query IDs properly.
    Security-critical: prevents regex injection in PromQL queries.
    """

    @pytest.fixture
    def generator(self):
        """Create a PostgresReportGenerator instance for testing."""
        return PostgresReportGenerator(
            prometheus_url="http://localhost:9090",
            postgres_sink_url=None
        )

    @pytest.mark.parametrize("case", get_valid_cases(QUERY_ID_VECTORS), ids=lambda c: c["id"])
    def test_valid_cases(self, generator, case):
        """Test that valid query IDs produce expected regex patterns."""
        if case.get("python_skip"):
            pytest.skip(f"Skipped for Python: {case.get('note', '')}")

        result = generator._build_qid_regex(case["input"])
        assert result == case["expected"], f"Input: {case['input']!r}, Expected: {case['expected']!r}, Got: {result!r}"
        assert case["outcome"] == "success"

    @pytest.mark.parametrize(
        "case",
        get_invalid_cases(QUERY_ID_VECTORS),
        ids=lambda c: c["id"] if isinstance(c, dict) else "empty"
    )
    def test_invalid_cases(self, generator, case):
        """Test that invalid query IDs raise ValueError.

        Security-critical: ensures regex injection attempts are rejected.
        """
        if case.get("python_skip"):
            pytest.skip(f"Skipped for Python: {case.get('note', '')}")

        assert case["outcome"] == "failure"

        # All invalid query ID cases should raise ValueError
        with pytest.raises(ValueError):
            generator._build_qid_regex(case["input"])
