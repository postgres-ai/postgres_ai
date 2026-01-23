# Test Coverage Strategy: Regression Safety for TypeScript Migration

| Version | Date | Changes | Breaking |
|---------|------|---------|----------|
| 2.3 | 2026-01-22 | **FINAL**: Fix schema bug, harness dispatches by outcome, rename legacy behavior tests, add Phase 0 spike | None |
| 2.2 | 2026-01-22 | Fix contradiction: TS enforces overflow, Python unchanged. Add `outcome` to vectors. Sanitizer fixes. Schema allows invalid-only. Scope coverage targets. | Vectors now require `outcome` field |
| 2.1 | 2026-01-22 | Error codes, snapshot sanitizers, DON'T refactor Python, shellcheck, vector schema, phase DoD, rollback plan | Error codes replace exception names |
| 2.0 | 2026-01-22 | Migration-first approach, risk-based tiers, compliance vectors | New vector format |
| 1.0 | 2026-01-22 | Initial draft | - |

> **Breaking change impact (v2.2):** Schema validation will fail until all vectors include `outcome` field.

---

## Executive Summary

This document outlines a **migration-first testing strategy** focused on **behavioral documentation**.

**Goal:** 100% regression safety for the TypeScript migration. Any behavioral difference between Python and TypeScript implementations will be caught by compliance vector tests before deployment.

**Vector Completeness:** Validated through code review (edge cases covered?) and property testing (does Hypothesis find cases not in vectors?).

**Key Principles:**
1. **Meaningful coverage** = tests that verify behavior and would fail if implementation breaks
2. **Language-agnostic test vectors** = JSON fixtures with `outcome` (shared) + error codes (TS-required)
3. **Don't gold-plate Python** = skip P2/P3 tests for code being migrated within 4 weeks
4. **Test Python as-is** = do NOT refactor legacy code; test current behavior, even if it returns `None` or crashes
5. **Error codes** = required for TypeScript, best-effort for Python (Python may not expose codes)

---

## 1. Current State (Measured)

### Action Required: Get Baseline

```bash
# Python reporter
pytest --cov=reporter --cov-report=term-missing --cov-report=xml

# CLI (TypeScript)
bun test --coverage

# Diff coverage for MRs
pip install diff-cover
diff-cover coverage.xml --compare-branch origin/main
```

Store baseline in CI artifacts AND print summary in job logs:

```yaml
# .gitlab-ci.yml
reporter:coverage-baseline:
  script:
    - pytest --cov=reporter --cov-report=xml --cov-report=term
    - |
      echo "=== Coverage Summary ===" | tee coverage_summary.txt
      coverage report --include="reporter/*" | tee -a coverage_summary.txt
  artifacts:
    paths:
      - coverage_summary.txt
      - coverage.xml
```

### Coverage Targets by Risk Tier

| Tier | Scope | Line | Branch | Gate | Failure Consequence |
|------|-------|------|--------|------|---------------------|
| **Critical** | `reporter/postgres_reports.py` (P0 functions) | 95%+ | 90%+ | Fail pipeline | Wrong memory recommendations → OOM or wasted resources on customer PostgreSQL |
| **High** | `monitoring_flask_backend/*.py` | 85%+ | 80%+ | Fail MR | API contract break, broken CSV output |
| **Medium** | `cli/lib/*.ts` | 75%+ | 70%+ | Warn (log message) | Lower risk, tested via integration |
| **Low** | `components/index_pilot/*.sh` | N/A | N/A | Shellcheck only | E2E covers critical paths |

### Migration Cutoff Rule

> If migration ETA ≤ 4 weeks, skip P2/P3 test expansion. ETA is based on the `TS-MIGRATION` milestone in GitLab; if not assigned, treat as >4 weeks.

### Shell Script Decision

**Do NOT write shell unit tests.** Options:

1. **Rewrite** in Python/Go/TypeScript
2. **Extract logic** into a library, keep bash as thin wrapper
3. **Accept risk** with mitigations:
   - Add `shellcheck` to CI (catches 90% of bash disasters)
   - Add 2-3 E2E smoke tests verifying exit codes

```yaml
# .gitlab-ci.yml - pin shellcheck version for stability
shell:lint:
  image: koalaman/shellcheck-alpine:v0.9.0
  script:
    - shellcheck components/index_pilot/*.sh
```

---

## 2. Migration-First Testing Strategy

### The "Rosetta Stone" Approach

Create **language-agnostic test vectors** with shared `outcome` + TS-specific error codes:

```
tests/
├── compliance_vectors/
│   ├── schema.json                    # JSON Schema for validation
│   ├── COVERAGE.md                    # Tracking file
│   ├── memory_parsing.json
│   ├── query_id_validation.json
│   └── report_inputs/                 # Input fixtures for reports (NOT snapshots)
│       ├── g001_normal_metrics.json
│       └── g001_empty_metrics.json
├── python/
│   └── test_compliance.py
├── typescript/                        # Future
│   └── compliance.test.ts
└── __snapshots__/                     # syrupy golden outputs (auto-generated)
```

### Test Vector Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["spec_version", "function"],
  "anyOf": [
    {"required": ["valid_cases"]},
    {"required": ["invalid_cases"]}
  ],
  "properties": {
    "spec_version": {"type": "string"},
    "function": {"type": "string"},
    "python_verified": {"type": ["string", "null"]},
    "typescript_verified": {"type": ["string", "null"]},
    "constraints": {"type": "object"},
    "case_groups": {
      "type": "object",
      "additionalProperties": {
        "type": "array",
        "items": {"$ref": "#/definitions/case"}
      }
    },
    "valid_cases": {"type": "array", "items": {"$ref": "#/definitions/valid_case"}},
    "invalid_cases": {"type": "array", "items": {"$ref": "#/definitions/invalid_case"}}
  },
  "definitions": {
    "case_base": {
      "type": "object",
      "required": ["id", "input", "outcome"],
      "properties": {
        "id": {"type": "string"},
        "input": {},
        "outcome": {"enum": ["success", "empty", "partial", "failure"]},
        "tags": {"type": "array", "items": {"type": "string"}},
        "note": {"type": "string"},
        "python_skip": {"type": "boolean"}
      }
    },
    "valid_case": {
      "allOf": [
        {"$ref": "#/definitions/case_base"},
        {"required": ["expected"]}
      ]
    },
    "invalid_case": {
      "allOf": [
        {"$ref": "#/definitions/case_base"},
        {"required": ["error_code"]}
      ]
    },
    "case": {
      "oneOf": [
        {"$ref": "#/definitions/valid_case"},
        {"$ref": "#/definitions/invalid_case"}
      ]
    }
  }
}
```

### Test Vector Format

```json
{
  "spec_version": "1.0",
  "function": "reporter.postgres_reports._parse_memory_value",
  "description": "Parses PostgreSQL memory configuration strings to bytes",
  "python_verified": "2026-01-22",
  "typescript_verified": null,

  "constraints": {
    "max_safe_value": 9007199254740991,
    "note": "TS enforces overflow; Python does not (legacy behavior preserved)"
  },

  "valid_cases": [
    {"id": "mem_valid_001", "input": "128MB", "expected": 134217728, "outcome": "success", "tags": ["basic"]},
    {"id": "mem_valid_002", "input": "4GB", "expected": 4294967296, "outcome": "success", "tags": ["basic"]},
    {"id": "mem_valid_003", "input": "8192", "expected": 67108864, "outcome": "success", "tags": ["blocks"], "note": "8192 blocks * 8KB/block = 64MB"}
  ],

  "case_groups": {
    "boundary": [
      {"id": "mem_bound_001", "input": "0", "expected": 0, "outcome": "success"},
      {"id": "mem_bound_002", "input": "1", "expected": 8192, "outcome": "success", "note": "minimum 1 block"}
    ],
    "format_variations": [
      {"id": "mem_fmt_001", "input": "  128MB  ", "expected": 134217728, "outcome": "success", "tags": ["whitespace"]},
      {"id": "mem_fmt_002", "input": "128mb", "expected": 134217728, "outcome": "success", "tags": ["case"]}
    ]
  },

  "invalid_cases": [
    {"id": "mem_err_001", "input": "", "outcome": "failure", "error_code": "ERR_EMPTY_INPUT"},
    {"id": "mem_err_002", "input": null, "outcome": "failure", "error_code": "ERR_NULL_INPUT"},
    {"id": "mem_err_003", "input": "invalid", "outcome": "failure", "error_code": "ERR_INVALID_FORMAT"},
    {"id": "mem_err_004", "input": "-1MB", "outcome": "failure", "error_code": "ERR_NEGATIVE_VALUE"},
    {"id": "mem_err_005", "input": "128XB", "outcome": "failure", "error_code": "ERR_UNKNOWN_UNIT"},
    {"id": "mem_err_006", "input": "9007199254740992", "outcome": "failure", "error_code": "ERR_OVERFLOW", "python_skip": true, "note": "TS-only: Python accepts large values (legacy)"}
  ]
}
```

### Standard Error Codes

| Code | Meaning | Python Behavior | TS Behavior |
|------|---------|-----------------|-------------|
| `ERR_EMPTY_INPUT` | Empty string | Raises `ValueError` | Throws `MemoryParseError` with `.code` |
| `ERR_NULL_INPUT` | Null/None | Raises `TypeError` | Throws `MemoryParseError` with `.code` |
| `ERR_INVALID_FORMAT` | Unrecognized | Raises `ValueError` | Throws `MemoryParseError` with `.code` |
| `ERR_NEGATIVE_VALUE` | Negative number | Raises `ValueError` | Throws `MemoryParseError` with `.code` |
| `ERR_UNKNOWN_UNIT` | Unknown suffix | Raises `ValueError` | Throws `MemoryParseError` with `.code` |
| `ERR_OVERFLOW` | >MAX_SAFE_INTEGER | **Accepts (legacy)** | Throws `MemoryParseError` with `.code` |

### Python Compliance Harness

```python
# tests/python/test_compliance.py
import json
import pytest
from pathlib import Path
from reporter.postgres_reports import _parse_memory_value

VECTORS_DIR = Path(__file__).parent.parent / "compliance_vectors"

# Load vectors once at module level
def load_vectors(name: str) -> dict:
    return json.loads((VECTORS_DIR / f"{name}.json").read_text())

MEMORY_VECTORS = load_vectors("memory_parsing")

# Error code to Python exception mapping
# Error codes are TS-required; Python maps them best-effort
ERROR_MAP = {
    "ERR_EMPTY_INPUT": ValueError,
    "ERR_NULL_INPUT": TypeError,
    "ERR_INVALID_FORMAT": ValueError,
    "ERR_NEGATIVE_VALUE": ValueError,
    "ERR_UNKNOWN_UNIT": ValueError,
    "ERR_OVERFLOW": ValueError,  # Python may not actually raise this
}

def get_valid_cases(vectors: dict) -> list:
    """Get all cases expecting success (have 'expected' field)"""
    cases = list(vectors.get("valid_cases", []))
    for group_cases in vectors.get("case_groups", {}).values():
        cases.extend(c for c in group_cases if "expected" in c)
    return cases

def get_invalid_cases(vectors: dict) -> list:
    """Get all cases expecting failure (have 'error_code' field)"""
    cases = list(vectors.get("invalid_cases", []))
    for group_cases in vectors.get("case_groups", {}).values():
        cases.extend(c for c in group_cases if "error_code" in c)
    return cases

class TestVectorSchemaValid:
    """Validate all vector files against schema"""

    def test_vectors_match_schema(self):
        import jsonschema
        schema = json.loads((VECTORS_DIR / "schema.json").read_text())
        for vector_file in VECTORS_DIR.glob("*.json"):
            if vector_file.name == "schema.json":
                continue
            data = json.loads(vector_file.read_text())
            jsonschema.validate(data, schema)

    def test_p0_vectors_have_invalid_cases(self):
        """P0 functions must have both valid and invalid cases"""
        p0_vectors = ["memory_parsing.json", "query_id_validation.json"]
        for name in p0_vectors:
            path = VECTORS_DIR / name
            if path.exists():
                data = json.loads(path.read_text())
                assert data.get("valid_cases") or data.get("case_groups"), f"{name} missing valid cases"
                assert data.get("invalid_cases"), f"{name} missing invalid cases"

class TestMemoryParsingCompliance:
    """Tests loaded from compliance_vectors/memory_parsing.json"""

    @pytest.mark.parametrize("case", get_valid_cases(MEMORY_VECTORS), ids=lambda c: c["id"])
    def test_valid_cases(self, case):
        if case.get("python_skip"):
            pytest.skip(f"Skipped for Python: {case.get('note', '')}")
        result = _parse_memory_value(case["input"])
        assert result == case["expected"]
        # Outcome should be success for valid cases
        assert case["outcome"] == "success"

    @pytest.mark.parametrize("case", get_invalid_cases(MEMORY_VECTORS), ids=lambda c: c["id"])
    def test_invalid_cases(self, case):
        if case.get("python_skip"):
            pytest.skip(f"Skipped for Python: {case.get('note', '')}")

        error_type = ERROR_MAP.get(case["error_code"], Exception)
        # Assert outcome is failure
        assert case["outcome"] == "failure"

        with pytest.raises(error_type):
            _parse_memory_value(case["input"])
```

### TypeScript Compliance Harness (Future)

```typescript
// tests/typescript/compliance.test.ts
import { describe, test, expect } from 'bun:test';
import memoryVectors from '../compliance_vectors/memory_parsing.json';
import { parseMemoryValue, MemoryParseError } from '../../lib/memory';

// Custom error class with code property
class MemoryParseError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MemoryParseError';
  }
}

function getAllCases(vectors: typeof memoryVectors): Array<any> {
  const cases = [...(vectors.valid_cases || [])];
  for (const groupCases of Object.values(vectors.case_groups || {})) {
    cases.push(...groupCases);
  }
  return cases;
}

describe('Memory Parsing Compliance', () => {
  const allValidCases = getAllCases(memoryVectors);

  test.each(allValidCases)('$id: parses $input', (c) => {
    expect(parseMemoryValue(c.input)).toBe(c.expected);
    expect(c.outcome).toBe('success');
  });

  test.each(memoryVectors.invalid_cases)('$id: rejects $input with $error_code', (c) => {
    expect(c.outcome).toBe('failure');
    try {
      parseMemoryValue(c.input);
      expect.fail(`Expected error ${c.error_code}`);
    } catch (e) {
      expect(e).toBeInstanceOf(MemoryParseError);
      expect((e as MemoryParseError).code).toBe(c.error_code);
    }
  });
});
```

### Vector Tracking File

```markdown
<!-- tests/compliance_vectors/COVERAGE.md -->
# Compliance Vector Coverage

| Function | Vector File | Python | TypeScript | Notes |
|----------|-------------|--------|------------|-------|
| `_parse_memory_value()` | memory_parsing.json | ✅ | ⬜ | Overflow is TS-only |
| `_analyze_memory_settings()` | memory_analysis.json | ⬜ | ⬜ | |
| `_build_qid_regex()` | query_id_validation.json | ⬜ | ⬜ | Security-critical |
| `get_all_nodes()` | - | ⬜ | ⬜ | Contract test only (shape, not computation) |

## Review Process
- Vector changes require review from Python maintainer AND TS migration lead
- New vectors must include `python_verified` date after tests pass
- `typescript_verified` set when TS harness passes all cases
- Production mismatches → new vector case + snapshot update
```

---

## 3. Priority Analysis (Migration-Adjusted)

### Priority Definitions

| Priority | Definition | Action |
|----------|-----------|--------|
| **P0** | Complex logic affecting customer data | Compliance vectors (valid + invalid) OR golden snapshots |
| **P1** | Silent failure risk | Compliance vectors |
| **P2** | Partially tested, migrating within 4 weeks | **SKIP** |
| **P3** | Well-tested | **SKIP** |

### P0: Must Test

| Function | File | Test Approach |
|----------|------|---------------|
| `_parse_memory_value()` | `reporter/postgres_reports.py` | Vectors + Hypothesis |
| `_analyze_memory_settings()` | `reporter/postgres_reports.py` | Vectors |
| `generate_g001_memory_settings_report()` | `reporter/postgres_reports.py` | Golden snapshots (4 cases) |
| `generate_k001_query_calls_report()` | `reporter/postgres_reports.py` | Golden snapshots (4 cases) |
| `generate_k003_top_queries_report()` | `reporter/postgres_reports.py` | Golden snapshots (4 cases) |
| `_build_qid_regex()` | `reporter/postgres_reports.py` | Vectors (security-critical) |
| `get_all_nodes()` | `reporter/postgres_reports.py` | Contract test only (returns `list[Node]` shape; handles empty, multiple primaries, unknown roles) |

### P1: Should Test

| Function | File | Test Approach |
|----------|------|---------------|
| `_get_pgss_metrics_data_by_db()` | `reporter/postgres_reports.py` | Golden snapshots (large I/O structure) |
| `_densify()` | `reporter/postgres_reports.py` | Property test (idempotent) |
| `_build_timeline()` | `reporter/postgres_reports.py` | Vectors |
| Flask CSV endpoints | `monitoring_flask_backend/app.py` | Contract tests |

---

## 4. Testing Techniques

### 4.1 Property-Based Testing (Hypothesis)

```python
from hypothesis import given, strategies as st, settings, HealthCheck
import os

# Set profile via env: HYPOTHESIS_PROFILE=ci
settings.register_profile("ci", max_examples=50, deadline=None,
                          suppress_health_check=[HealthCheck.too_slow])
settings.register_profile("local", max_examples=200)
settings.load_profile(os.getenv("HYPOTHESIS_PROFILE", "local"))

class TestMemoryParsingProperties:
    """Property-based tests that find edge cases not in vectors"""

    @given(st.integers(min_value=0, max_value=10_000))  # MB values, bounded
    def test_parsing_is_case_insensitive(self, mb_value):
        """Verify case insensitivity (documented in memory_parsing.json format_variations)"""
        upper = f"{mb_value}MB"
        lower = f"{mb_value}mb"
        assert _parse_memory_value(upper) == _parse_memory_value(lower)

    @given(st.text(max_size=100))
    def test_never_crashes_on_arbitrary_input(self, text):
        """Should raise ValueError/TypeError, never crash unexpectedly"""
        try:
            result = _parse_memory_value(text)
            assert isinstance(result, int)
            assert result >= 0
        except (ValueError, TypeError):
            pass  # Expected
        except Exception as e:
            pytest.fail(f"Unexpected exception: {type(e).__name__}: {e}")

    @given(st.integers(min_value=0, max_value=1000))
    def test_densify_is_idempotent(self, hours):
        """densify(densify(x)) == densify(x) - metamorphic property"""
        timeline = _build_timeline(hours, 3600)
        series = {"test": [(t, 42) for t in timeline[:5]]}

        result1 = _densify(series, timeline)
        result2 = _densify(result1, timeline)
        assert result1 == result2
```

### 4.2 Golden Snapshot Tests

Use **4 tests per report** with sanitizers that only scrub **identity volatility**, not logic outputs:

```python
import pytest
from syrupy import SnapshotAssertion
import requests

class SnapshotSanitizer:
    """Normalize volatile identity fields only - preserve logic outputs"""

    # Fields that are truly volatile (change between runs)
    VOLATILE_IDENTITY = {"created_at", "generated_at", "timestamp", "request_id", "run_id"}

    # Fields that are computed but meaningful - DO NOT sanitize
    # duration_ms, query_time_ms, etc. are logic outputs

    @staticmethod
    def sanitize(data):
        if isinstance(data, dict):
            result = {}
            for k, v in data.items():
                if k in SnapshotSanitizer.VOLATILE_IDENTITY:
                    if "id" in k:
                        result[k] = "00000000-0000-0000-0000-000000000000"
                    else:
                        result[k] = "2026-01-01T00:00:00Z"
                else:
                    result[k] = SnapshotSanitizer.sanitize(v)
            return result
        elif isinstance(data, list):
            # Only sort lists of primitives (sets); preserve order for ranked lists
            sanitized = [SnapshotSanitizer.sanitize(item) for item in data]
            if all(isinstance(x, (str, int, float, bool, type(None))) for x in sanitized):
                return sorted(sanitized, key=lambda x: (x is None, x))
            return sanitized  # Preserve order for complex structures (e.g., top_queries)
        return data

class TestG001MemorySettingsReport:
    """Golden snapshot tests for generate_g001_memory_settings_report()

    Snapshots stored in tests/__snapshots__/
    Snapshot changes require explicit review in MR diff.
    "Stable" = no diffs across 3 CI runs on same commit.
    """

    def test_happy_path(self, snapshot: SnapshotAssertion, mock_prometheus):
        """Normal operation with valid metrics"""
        mock_prometheus.return_value = FIXTURE_NORMAL_METRICS
        result = generator.generate_g001_memory_settings_report()
        assert SnapshotSanitizer.sanitize(result) == snapshot

    def test_empty_metrics(self, snapshot: SnapshotAssertion, mock_prometheus):
        """Prometheus returns empty data"""
        mock_prometheus.return_value = {"status": "success", "data": {"result": []}}
        result = generator.generate_g001_memory_settings_report()
        assert SnapshotSanitizer.sanitize(result) == snapshot


class TestG001LegacyBehaviorContract:
    """Legacy behavior contract tests - document current Python behavior without snapshots.

    These tests assert that Python behaves a certain way (raises exception, returns None)
    so that TS migration can decide whether to preserve or improve that behavior.
    NOT snapshot tests - they verify exception types and return values.
    """

    def test_malformed_input_raises_keyerror(self, mock_prometheus):
        """Prometheus returns unexpected structure - document actual behavior"""
        mock_prometheus.return_value = {"status": "success", "data": None}
        # Actual behavior: raises KeyError (verified 2026-01-22)
        # TS should return ReportResult with MALFORMED_RESPONSE instead
        with pytest.raises(KeyError):
            generator.generate_g001_memory_settings_report()

    def test_prometheus_unavailable_returns_none(self, mock_prometheus):
        """Prometheus connection fails"""
        mock_prometheus.side_effect = requests.exceptions.ConnectionError("connection refused")
        result = generator.generate_g001_memory_settings_report()
        # Actual behavior: returns None (verified 2026-01-22)
        # TS should return ReportResult with PROM_UNAVAILABLE instead
        assert result is None
```

### 4.3 Contract Tests (Flask Endpoints)

```python
import pytest
import psycopg2

@pytest.fixture
def mock_db_unavailable(mocker):
    mocker.patch('monitoring_flask_backend.app.get_db_connection',
                 side_effect=psycopg2.OperationalError("connection refused"))

class TestPgssMetricsCsvEndpoint:
    """Contract tests for /pgss_metrics/csv"""

    def test_returns_csv_content_type(self, client):
        response = client.get("/pgss_metrics/csv")
        assert response.content_type.startswith("text/csv")

    def test_has_required_headers(self, client):
        response = client.get("/pgss_metrics/csv")
        lines = response.data.decode().split("\n")
        headers = lines[0].split(",")
        assert "queryid" in headers
        assert "calls" in headers

    def test_rejects_invalid_params(self, client):
        response = client.get("/pgss_metrics/csv?limit=invalid")
        assert response.status_code == 400

    def test_handles_db_unavailable(self, client, mock_db_unavailable):
        response = client.get("/pgss_metrics/csv")
        assert response.status_code == 503
```

---

## 5. Error Semantics

### Critical Rule: Do NOT Refactor Python

> **Test Python code AS-IS.** Do not change return signatures or add new validation. You risk introducing bugs in code you're about to delete.

**Divergent implementations, convergent outcomes:**
- Python test expects `None` or raises exception (current behavior)
- TS test expects structured `ReportResult` with error codes (new design)
- Shared vector asserts `outcome: "failure"` (both agree it failed)

### Expected Behavior Matrix (Verified)

| Scenario | Python (current, verified) | TypeScript (new) | Vector Outcome |
|----------|---------------------------|------------------|----------------|
| Prometheus unavailable | Returns `None` | `ReportResult` with `PROM_UNAVAILABLE` | `failure` |
| Malformed response | Raises `KeyError` | `ReportResult` with `MALFORMED_RESPONSE` | `failure` |
| Empty metrics | Returns `{}` | `ReportResult` with `no_data: true` | `empty` |
| Overflow value | **Accepts (legacy)** | Throws `ERR_OVERFLOW` | `failure` (TS-only) |

### Partial Report Semantics (TS only)

When some subqueries fail but others succeed:
- Return `partial: true` + data + structured errors
- Caller decides whether to use partial data

---

## 6. Test Quality Beyond Coverage

### 6.1 Diff Coverage (MR Gate)

```yaml
# .gitlab-ci.yml
reporter:diff-coverage:
  stage: test
  variables:
    PIP_CACHE_DIR: "$CI_PROJECT_DIR/.pip-cache"
  cache:
    - key:
        files: [requirements.txt, requirements-dev.txt]
      paths: [.pip-cache/]
  script:
    - pip install diff-cover
    - pytest --cov=reporter --cov-report=xml
    - |
      # Use JSON output for reliable parsing
      diff-cover coverage.xml --compare-branch origin/main --json-report diff.json --fail-under=90 || {
        LINES=$(python -c "import json; print(json.load(open('diff.json')).get('total_num_lines', 0))")
        if [ "$LINES" = "0" ]; then
          echo "No Python lines changed, skipping coverage gate"
          exit 0
        fi
        exit 1
      }
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

### 6.2 Flaky Test Detection

Run repeats only on high-value tests (compliance + snapshots):

```yaml
reporter:flaky-check:
  stage: test
  script:
    - pip install pytest-repeat
    - pytest tests/python/test_compliance.py tests/reporter/test_*snapshot*.py -v --count=3 --repeat-scope=session
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  allow_failure: true
  artifacts:
    reports:
      junit: flaky-report.xml
    when: always
```

### 6.3 Mutation Testing (Optional, Monthly)

> Lower priority for migrating code. Run monthly on stable modules.

```bash
pip install mutmut
mutmut run --paths-to-mutate=reporter/postgres_reports.py \
           --tests-dir=tests/reporter \
           --runner="pytest tests/python/test_compliance.py -x"
```

---

## 7. CI Optimization

### Fast Path: Migration Gate

Add a quick job that runs only compliance + snapshots:

```yaml
reporter:migration-gate:
  stage: test
  script:
    - pytest tests/python/test_compliance.py tests/reporter/test_*snapshot*.py -v
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

### Parallelization (Choose One)

```yaml
# Option A: GitLab job parallelization with pytest-split
reporter:tests:unit:
  parallel: 3
  script:
    - pip install pytest-split
    - pytest tests/reporter -m unit --splits=${CI_NODE_TOTAL} --group=${CI_NODE_INDEX}

# Option B: pytest-xdist only
reporter:tests:unit:
  script:
    - pytest tests/reporter -m unit -n auto --dist=loadfile
```

### Cache Configuration

```yaml
variables:
  PIP_CACHE_DIR: "$CI_PROJECT_DIR/.pip-cache"

cache:
  - key:
      files: [requirements.txt, requirements-dev.txt]
    paths: [.pip-cache/]
  - key:
      files: [bun.lockb]
    paths: [node_modules/, .bun/install/cache/]
```

### Target CI Times

> Current: ~6min (to be measured). Target: <3min.

| Stage | Target | Method |
|-------|--------|--------|
| Migration gate | <15s | Compliance + snapshots only |
| Unit tests | <30s | Parallel, no I/O |
| Integration | <60s | Session-scoped DB |
| **Total** | <3min | |

---

## 8. TypeScript Migration Constraints

### Decision: TS Enforces Overflow, Python Does Not

JavaScript `number` is safe up to `2^53 - 1`. **TS enforces this; Python does not (legacy behavior preserved).**

```typescript
// TypeScript - enforces overflow
const MAX_SAFE_VALUE = 9007199254740991;

function parseMemoryValue(input: string): number {
  const bytes = parseMemoryValueInternal(input);
  if (bytes > MAX_SAFE_VALUE) {
    throw new MemoryParseError('ERR_OVERFLOW', `Value ${bytes} exceeds safe integer range`);
  }
  return bytes;
}
```

```python
# Python - NO CHANGE (legacy behavior preserved)
# Large values are accepted; overflow cases in vectors have python_skip: true
def _parse_memory_value(input: str) -> int:
    # ... existing implementation unchanged ...
```

Overflow test cases in vectors have `python_skip: true` until Python is retired.

---

## 9. Implementation Plan

> Week 1 starts when this doc is approved (target: 2026-01-27).

### Phase 0: Spike (Day 0) ✅ COMPLETE

**Goal:** Validate the approach before committing to full implementation.

| Task | Owner | Deliverable | Status |
|------|-------|-------------|--------|
| Create single vector file (`memory_parsing.json`) | Python maintainer | 24 cases covering basic + edge | ✅ Done |
| Create minimal Python harness | Python maintainer | `test_compliance.py` runs all cases | ✅ Done |
| Verify harness catches real bugs | Python maintainer | Found `128XB` raises ValueError (documented) | ✅ Done |
| Review with TS migration lead | Both leads | Agreement on vector format | ⏳ Pending |

**Definition of Done:** Single vector file works end-to-end, both leads sign off on format.

**Key Discovery:** Python `_parse_memory_value` returns 0 for most invalid inputs but raises `ValueError` when input ends with 'B' and the prefix isn't a valid float (e.g., `128XB`). This nuance validates the compliance vector approach.

**Exit criteria:** If spike reveals fundamental issues with approach, revisit strategy before proceeding.

### Phase 1: Compliance Vectors (Days 1-3) ✅ COMPLETE

| Task | Owner | Deliverable | Status |
|------|-------|-------------|--------|
| Create `tests/compliance_vectors/` structure | Python maintainer | Directory + schema.json | ✅ Done |
| Write `memory_parsing.json` | Python maintainer | 24 cases with IDs, outcomes, error codes | ✅ Done |
| Write `query_id_validation.json` | Python maintainer | 20 cases (security-critical) | ✅ Done |
| Create Python compliance harness | Python maintainer | `test_compliance.py` (44 tests) | ✅ Done |
| Add vector schema validation | Python maintainer | CI passes | ✅ Done |
| Add shellcheck to CI | DevOps | Already in `components/index_pilot/.gitlab-ci.yml` | ✅ Pre-existing |

**Definition of Done:** Vectors schema validated in CI, Python harness runs all non-skipped cases, shellcheck passes.

### Phase 2: Property Tests + Snapshots (Days 4-7)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Add Hypothesis + syrupy | Python maintainer | `requirements-dev.txt` |
| Property tests for `_parse_memory_value` | Python maintainer | 3 property tests |
| Property tests for `_densify` | Python maintainer | Idempotence test |
| Golden snapshots for G001, K001, K003 | Python maintainer | 4 snapshots each with sanitizer |
| Verify actual Python error behavior | Python maintainer | Update behavior matrix |

**Definition of Done:** Snapshots stable across 3 CI runs on same commit. Sanitizer handles only identity fields.

### Phase 3: Error Semantics + Contracts (Days 8-10)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Document current Python error behavior | Python maintainer | Verified matrix in this doc |
| Define TS error codes + MemoryParseError | TS migration lead | Error code enum + class |
| Flask endpoint contract tests | Python maintainer | 5 endpoints covered |

**Definition of Done:** Error codes defined, Python behavior documented (not changed), contracts tested.

### Phase 4: CI Hardening (Days 11-14)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Add diff-coverage to MR pipeline | DevOps | `.gitlab-ci.yml` |
| Add flaky test detection | DevOps | `.gitlab-ci.yml` |
| Add migration-gate fast path | DevOps | `.gitlab-ci.yml` |
| Fix parallelization (choose one model) | DevOps | `.gitlab-ci.yml` |

**Definition of Done:** CI time <3min, no flaky failures in 10 consecutive runs.

### Stop Condition

> If vectors uncover ambiguous behavior in Python, **decide the spec first** and document it before porting to TS. Do not port ambiguity.

### Phase Dependencies

```
Phase 0 ──────> Phase 1 ──────┬──────> Phase 2 ──────> Phase 4
                              │
                              └──────> Phase 3 ──────┘
```

Phase 0 must complete before Phase 1. Phase 2 can start when `memory_parsing.json` + harness merged. Phase 3 is independent.

---

## 10. Mocking Guidelines

| Dependency | Unit Tests | Integration Tests |
|-----------|------------|-------------------|
| Prometheus API | Always mock | May use real |
| PostgreSQL | Mock if used | Use pytest-postgresql |
| External APIs | Always mock | Always mock |
| File system | Use `pyfakefs` or mock | Real files OK |
| Time/dates | Mock `datetime.now()` | Mock or real |

**Rules:**
- Never mock the code under test
- Prefer dependency injection over `patch()`
- If you need 5+ patches, refactor via constructor injection

---

## 11. Test Data Management

| Size | Location | Example |
|------|----------|---------|
| Small (< 10 values) | Inline in test | `["a", "b", "c"]` |
| Medium (10-100 values) | `tests/fixtures/` | Prometheus responses |
| Large (> 100 values) | `compliance_vectors/` | Memory parsing cases |
| Generated | Hypothesis strategies | Arbitrary text fuzzing |

**Fixture loader with parametrize:**

```python
FIXTURE_DIR = Path(__file__).parent / "fixtures"

@pytest.fixture
def prom_response(request):
    path = FIXTURE_DIR / f"prometheus/{request.param}.json"
    return json.loads(path.read_text())

@pytest.mark.parametrize("prom_response", ["normal", "empty", "error"], indirect=True)
def test_with_different_responses(prom_response):
    result = process(prom_response)
    assert result is not None
```

**Never commit:** Large binaries, production data, generated reports.

---

## 12. Success Criteria

### Quantitative

| Metric | Target | Measured How |
|--------|--------|--------------|
| Compliance vectors pass | 100% (non-skipped) | pytest harness |
| Golden snapshots stable | No unexpected diffs | 3 CI runs on same commit |
| Diff coverage on MRs | 90%+ | diff-cover JSON |
| CI time (total) | <3min | GitLab metrics |
| Flaky test rate | <1% of executions | 100 runs with `--count=3` |
| P0 function coverage | 95%+ | pytest-cov (secondary) |

### Qualitative

- [ ] All P0 functions have vectors with `outcome` and error codes (or golden snapshots)
- [ ] All report generators have 4 golden snapshots with identity-only sanitizers
- [ ] Current Python error behavior documented (not refactored)
- [ ] TS error codes defined with `.code` property
- [ ] Compliance vectors work for both harnesses
- [ ] Shellcheck passes for index_pilot
- [ ] `pytest-socket` blocks network in unit tests

---

## 13. Rollback Plan

If TS migration discovers behavioral differences in production:

1. **Do NOT silently diverge** - both must match spec
2. Create minimal **new vector case** reproducing the issue
3. **Decide correct behavior** (escalate to tech lead if teams disagree)
4. Fix **both** implementations to match spec
5. Update snapshots if affected

> "Compliance vectors are the spec. If reality doesn't match the spec, fix reality."

**Escalation:** If Python and TS teams disagree on correct behavior, escalate to tech lead. Deciding factor: what behavior serves customers best?

---

## Appendix: Quick Reference

### Commands

```bash
# Run compliance tests
pytest tests/python/test_compliance.py -v

# Validate vector schema
pytest tests/python/test_compliance.py::TestVectorSchemaValid -v

# Run with Hypothesis CI profile
HYPOTHESIS_PROFILE=ci pytest tests/reporter -k "property"

# Update snapshots
pytest --snapshot-update

# Check diff coverage
diff-cover coverage.xml --compare-branch origin/main --json-report diff.json

# Lint shell scripts
shellcheck components/index_pilot/*.sh
```

### New Dependencies

```
# requirements-dev.txt
hypothesis>=6.0
syrupy>=4.0
diff-cover>=8.0
pytest-repeat>=0.9
pytest-split>=0.8
pytest-socket>=0.6       # Blocks network in unit tests - fails immediately if test makes HTTP request
jsonschema>=4.0
```

---

*Document version: 2.3 (FINAL)*
*Updated: 2026-01-22*
*Focus: Schema complete, harness dispatches by outcome, legacy behavior tests separated*
