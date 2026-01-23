# Test Coverage Strategy: Regression Safety for TypeScript Migration

| Version | Date | Changes |
|---------|------|---------|
| 2.1 | 2026-01-22 | Address reviewer feedback: error codes (not exception names), snapshot sanitizers, DON'T refactor Python, shellcheck, structured errors, vector schema, phase DoD, rollback plan |
| 2.0 | 2026-01-22 | Major rewrite: migration-first approach, risk-based tiers, compliance vectors, property testing, golden snapshots, error semantics, CI fixes |
| 1.0 | 2026-01-22 | Initial draft: comprehensive coverage strategy with 12-step implementation plan |

---

## Executive Summary

This document outlines a **migration-first testing strategy** focused on **behavioral documentation** rather than coverage metrics.

**Goal:** 100% regression safety for specified compliance vectors, golden snapshots, and defined error semantics. Any behavioral difference between Python and TypeScript implementations will be caught by compliance vector tests before deployment.

**Key Principles:**
1. **Meaningful coverage** = tests that verify behavior and would fail if implementation breaks
2. **Language-agnostic test vectors** = JSON fixtures with semantic error codes, shared between Python and TypeScript
3. **Don't gold-plate Python** = skip P2/P3 tests for code being migrated within 4 weeks
4. **Test Python as-is** = do NOT refactor legacy code to make it "testable"; test current behavior
5. **Define error semantics** = structured error codes, explicit partial report behavior

---

## 1. Current State (Measured)

### Action Required: Get Actual Numbers

Before proceeding, run actual coverage reports and establish baseline:

```bash
# Python reporter
pytest --cov=reporter --cov-report=term-missing --cov-report=xml

# CLI (TypeScript)
bun test --coverage

# Extract diff coverage for MRs
pip install diff-cover
diff-cover coverage.xml --compare-branch origin/main
```

Store baseline in CI artifacts for visibility per MR.

### Coverage Targets by Risk Tier

| Tier | Components | Line Target | Branch Target | Gate | Failure Consequence |
|------|-----------|-------------|---------------|------|---------------------|
| **Critical** | Memory parsing, query ID handling, report generators | 95%+ | 90%+ | Fail pipeline | Wrong advice/config recommendations |
| **High** | API endpoints, data formatting | 85%+ | 80%+ | Fail MR only | API contract break, broken formatting |
| **Medium** | Internal utilities, CLI wiring | 75%+ | 70%+ | Warn | Lower risk, tested via integration |
| **Low/Skip** | Shell scripts (index_pilot) | N/A | N/A | Shellcheck only | E2E covers critical paths |

### Migration Cutoff Rule

> If migration ETA ≤ 4 weeks, skip P2/P3 test expansion. If code is P0 AND being migrated within 4 weeks, write compliance vectors first—they serve both purposes.

### Shell Script Decision

**Do NOT write shell unit tests.** Choose one:

1. **Rewrite `index_pilot` in Python/Go/TypeScript** as part of this sprint
2. **Extract logic into a library** (Python/TS) and keep bash as thin wrapper
3. **Accept the risk** with mitigations:
   - Add `shellcheck` to CI (catches 90% of bash disasters)
   - Add 2-3 E2E smoke tests that invoke the script and verify exit codes

```yaml
# .gitlab-ci.yml
shell:lint:
  script:
    - shellcheck components/index_pilot/*.sh
```

---

## 2. Migration-First Testing Strategy

### The "Rosetta Stone" Approach

Create **language-agnostic test vectors** with semantic error codes:

```
tests/
├── compliance_vectors/
│   ├── schema.json                    # JSON Schema for validation
│   ├── COVERAGE.md                    # Tracking file
│   ├── memory_parsing.json
│   ├── query_id_validation.json
│   ├── timeline_generation.json
│   └── report_snapshots/
│       ├── g001_happy_path.json
│       └── ...
├── python/
│   └── test_compliance.py
└── typescript/                        # Future
    └── compliance.test.ts
```

### Test Vector Schema

```json
// tests/compliance_vectors/schema.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["spec_version", "function", "valid_cases"],
  "properties": {
    "spec_version": {"type": "string"},
    "function": {"type": "string"},
    "python_verified": {"type": ["string", "null"]},
    "typescript_verified": {"type": ["string", "null"]},
    "constraints": {"type": "object"},
    "valid_cases": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "input", "expected"],
        "properties": {
          "id": {"type": "string"},
          "input": {},
          "expected": {},
          "tags": {"type": "array", "items": {"type": "string"}},
          "note": {"type": "string"}
        }
      }
    },
    "invalid_cases": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "input", "error_code"],
        "properties": {
          "id": {"type": "string"},
          "input": {},
          "error_code": {"type": "string"},
          "error_message_contains": {"type": "string"},
          "tags": {"type": "array"},
          "note": {"type": "string"}
        }
      }
    }
  }
}
```

### Test Vector Format (with Error Codes)

```json
// tests/compliance_vectors/memory_parsing.json
{
  "spec_version": "1.0",
  "function": "reporter.postgres_reports._parse_memory_value",
  "description": "Parses PostgreSQL memory configuration strings to bytes",
  "python_verified": "2026-01-22",
  "typescript_verified": null,

  "constraints": {
    "max_safe_value": 9007199254740991,
    "behavior_on_overflow": "ERR_OVERFLOW"
  },

  "valid_cases": [
    {"id": "mem_valid_001", "input": "128MB", "expected": 134217728, "tags": ["basic"], "note": "128 * 1024 * 1024"},
    {"id": "mem_valid_002", "input": "4GB", "expected": 4294967296, "tags": ["basic"]},
    {"id": "mem_valid_003", "input": "1TB", "expected": 1099511627776, "tags": ["large"]},
    {"id": "mem_valid_004", "input": "64kB", "expected": 65536, "tags": ["basic", "lowercase"]},
    {"id": "mem_valid_005", "input": "8192", "expected": 67108864, "tags": ["blocks"], "note": "8192 blocks * 8KB/block = 64MB"}
  ],

  "boundary_cases": [
    {"id": "mem_bound_001", "input": "0", "expected": 0, "tags": ["boundary"]},
    {"id": "mem_bound_002", "input": "1", "expected": 8192, "tags": ["boundary"], "note": "minimum 1 block"},
    {"id": "mem_bound_003", "input": "1B", "expected": 1, "tags": ["boundary"]},
    {"id": "mem_bound_004", "input": "1023KB", "expected": 1047552, "tags": ["boundary"], "note": "just under 1MB"},
    {"id": "mem_bound_005", "input": "1024KB", "expected": 1048576, "tags": ["boundary"], "note": "exactly 1MB"}
  ],

  "format_variations": [
    {"id": "mem_fmt_001", "input": "  128MB  ", "expected": 134217728, "tags": ["whitespace"]},
    {"id": "mem_fmt_002", "input": "128mb", "expected": 134217728, "tags": ["case"]},
    {"id": "mem_fmt_003", "input": "128Mb", "expected": 134217728, "tags": ["case"]},
    {"id": "mem_fmt_004", "input": "1.5GB", "expected": 1610612736, "tags": ["decimal"]}
  ],

  "invalid_cases": [
    {"id": "mem_err_001", "input": "", "error_code": "ERR_EMPTY_INPUT", "tags": ["empty"]},
    {"id": "mem_err_002", "input": null, "error_code": "ERR_NULL_INPUT", "tags": ["null"]},
    {"id": "mem_err_003", "input": "invalid", "error_code": "ERR_INVALID_FORMAT", "tags": ["format"]},
    {"id": "mem_err_004", "input": "-1MB", "error_code": "ERR_NEGATIVE_VALUE", "tags": ["negative"]},
    {"id": "mem_err_005", "input": "128XB", "error_code": "ERR_UNKNOWN_UNIT", "tags": ["unit"]},
    {"id": "mem_err_006", "input": "9007199254740992", "error_code": "ERR_OVERFLOW", "tags": ["overflow"], "note": "exceeds MAX_SAFE_INTEGER"}
  ]
}
```

### Standard Error Codes

| Code | Meaning | Python Maps To | TS Maps To |
|------|---------|----------------|------------|
| `ERR_EMPTY_INPUT` | Empty string provided | `ValueError` | `Error` |
| `ERR_NULL_INPUT` | Null/None provided | `TypeError` | `Error` |
| `ERR_INVALID_FORMAT` | Unrecognized format | `ValueError` | `Error` |
| `ERR_NEGATIVE_VALUE` | Negative number | `ValueError` | `Error` |
| `ERR_UNKNOWN_UNIT` | Unknown unit suffix | `ValueError` | `Error` |
| `ERR_OVERFLOW` | Exceeds MAX_SAFE_INTEGER | `ValueError` | `Error` |

### Python Compliance Harness

```python
# tests/python/test_compliance.py
import json
import pytest
from pathlib import Path
from reporter.postgres_reports import _parse_memory_value

VECTORS_DIR = Path(__file__).parent.parent / "compliance_vectors"

# Error code to exception mapping
ERROR_MAP = {
    "ERR_EMPTY_INPUT": ValueError,
    "ERR_NULL_INPUT": TypeError,
    "ERR_INVALID_FORMAT": ValueError,
    "ERR_NEGATIVE_VALUE": ValueError,
    "ERR_UNKNOWN_UNIT": ValueError,
    "ERR_OVERFLOW": ValueError,
}

@pytest.fixture(scope="module")
def memory_vectors():
    return json.loads((VECTORS_DIR / "memory_parsing.json").read_text())

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

class TestMemoryParsingCompliance:
    """Tests loaded from compliance_vectors/memory_parsing.json"""

    @pytest.mark.parametrize("case",
        json.loads((VECTORS_DIR / "memory_parsing.json").read_text())["valid_cases"],
        ids=lambda c: c["id"])
    def test_valid_cases(self, case):
        assert _parse_memory_value(case["input"]) == case["expected"]

    @pytest.mark.parametrize("case",
        json.loads((VECTORS_DIR / "memory_parsing.json").read_text()).get("boundary_cases", []),
        ids=lambda c: c["id"])
    def test_boundary_cases(self, case):
        assert _parse_memory_value(case["input"]) == case["expected"]

    @pytest.mark.parametrize("case",
        json.loads((VECTORS_DIR / "memory_parsing.json").read_text()).get("invalid_cases", []),
        ids=lambda c: c["id"])
    def test_invalid_cases(self, case):
        error_type = ERROR_MAP.get(case["error_code"], Exception)
        with pytest.raises(error_type):
            _parse_memory_value(case["input"])
```

### TypeScript Compliance Harness (Future)

```typescript
// tests/typescript/compliance.test.ts
import { describe, test, expect } from 'bun:test';
import memoryVectors from '../compliance_vectors/memory_parsing.json';
import { parseMemoryValue, MemoryParseError } from '../../lib/memory';

// Error code mapping
const ERROR_MAP: Record<string, string> = {
  ERR_EMPTY_INPUT: 'empty',
  ERR_INVALID_FORMAT: 'format',
  ERR_OVERFLOW: 'overflow',
};

describe('Memory Parsing Compliance', () => {
  test.each(memoryVectors.valid_cases)('$id: parses $input', (c) => {
    expect(parseMemoryValue(c.input)).toBe(c.expected);
  });

  test.each(memoryVectors.invalid_cases)('$id: rejects $input with $error_code', (c) => {
    expect(() => parseMemoryValue(c.input)).toThrow(ERROR_MAP[c.error_code] ?? c.error_code);
  });
});
```

### Vector Tracking File

```markdown
<!-- tests/compliance_vectors/COVERAGE.md -->
# Compliance Vector Coverage

| Function | Vector File | Python | TypeScript | Notes |
|----------|-------------|--------|------------|-------|
| `_parse_memory_value()` | memory_parsing.json | ✅ | ⬜ | |
| `_analyze_memory_settings()` | memory_analysis.json | ⬜ | ⬜ | |
| `_build_qid_regex()` | query_id_validation.json | ⬜ | ⬜ | |
| `_build_timeline()` | timeline_generation.json | ⬜ | ⬜ | |
| `_densify()` | timeline_generation.json | ⬜ | ⬜ | |

## Review Process
- Compliance vector changes require review from both a Python maintainer and the TS migration lead
- New vectors must include `python_verified` date after tests pass
- `typescript_verified` set when TS harness passes all cases
```

---

## 3. Priority Analysis (Migration-Adjusted)

### Priority Definitions

| Priority | Definition | Action |
|----------|-----------|--------|
| **P0** | Untested code with complex logic that affects customer data | Write compliance vectors + property tests |
| **P1** | Untested code that could silently fail | Write compliance vectors |
| **P2** | Partially tested code being migrated within 4 weeks | **SKIP** - accept current coverage |
| **P3** | Well-tested code | **SKIP** - don't expand |

### P0: Must Test (Complex Logic)

| Function | File | Test Approach |
|----------|------|---------------|
| `_parse_memory_value()` | `reporter/postgres_reports.py` | Compliance vectors + Hypothesis |
| `_analyze_memory_settings()` | `reporter/postgres_reports.py` | Compliance vectors |
| `generate_g001_memory_settings_report()` | `reporter/postgres_reports.py` | Golden snapshots (4 cases) |
| `generate_k001_query_calls_report()` | `reporter/postgres_reports.py` | Golden snapshots (4 cases) |
| `generate_k003_top_queries_report()` | `reporter/postgres_reports.py` | Golden snapshots (4 cases) |
| `_build_qid_regex()` | `reporter/postgres_reports.py` | Compliance vectors + security cases |
| `get_all_nodes()` | `reporter/postgres_reports.py` | Contract test: returns `list[Node]` with `hostname`, `role`, `port`; handles empty nodes, multiple primaries, unknown roles |

### P1: Should Test (Silent Failure Risk)

| Function | File | Test Approach |
|----------|------|---------------|
| `_get_pgss_metrics_data_by_db()` | `reporter/postgres_reports.py` | Compliance vectors |
| `_densify()` | `reporter/postgres_reports.py` | Property test (idempotent) |
| `_build_timeline()` | `reporter/postgres_reports.py` | Compliance vectors |
| Flask CSV endpoints | `monitoring_flask_backend/app.py` | Contract tests |

### P2/P3: Skip for Now

Do **NOT** add tests for:
- `format_epoch_timestamp()` - low risk, being migrated (but add 1 small vector file if used in golden snapshots)
- `_floor_hour()` - trivial, being migrated
- `filter_a003_settings()` - well-tested via integration
- Expanding edge cases on already-tested methods

---

## 4. Testing Techniques

### 4.1 Property-Based Testing (Hypothesis)

For parsers and pure functions, use Hypothesis with bounded profiles:

```python
from hypothesis import given, strategies as st, assume, settings, Phase

# CI profile: fewer examples, faster
settings.register_profile("ci", max_examples=50, deadline=None)
# Local profile: more thorough
settings.register_profile("local", max_examples=200)

class TestMemoryParsingProperties:
    """Property-based tests that find edge cases automatically"""

    @given(st.integers(min_value=0, max_value=2**53))  # TS-safe range
    @settings(phases=[Phase.generate])  # Skip shrinking in CI
    def test_parsing_is_case_insensitive(self, value):
        """Same value with different case should parse identically"""
        formatted = f"{value}MB"
        assert _parse_memory_value(formatted.upper()) == _parse_memory_value(formatted.lower())

    @given(st.text())
    def test_never_crashes_on_arbitrary_input(self, text):
        """Should raise ValueError/TypeError, never crash unexpectedly"""
        try:
            result = _parse_memory_value(text)
            assert isinstance(result, int)
            assert result >= 0
        except (ValueError, TypeError):
            pass  # Expected for invalid input
        except Exception as e:
            pytest.fail(f"Unexpected exception: {type(e).__name__}: {e}")

    @given(st.integers(min_value=0, max_value=1000))
    def test_densify_is_idempotent(self, hours):
        """densify(densify(x)) == densify(x)"""
        timeline = _build_timeline(hours, 3600)
        series = {"test": [(t, 42) for t in timeline[:5]]}

        result1 = _densify(series, timeline)
        result2 = _densify(result1, timeline)
        assert result1 == result2
```

### 4.2 Golden Snapshot Tests (Report Generators)

Use **4 golden tests per report** with mandatory sanitizers for stability:

```python
import pytest
from syrupy import SnapshotAssertion
from syrupy.filters import props
import re

class SnapshotSanitizer:
    """Normalize volatile fields for stable snapshots"""

    @staticmethod
    def sanitize(data: dict) -> dict:
        """Replace timestamps, durations, and IDs with stable values"""
        if isinstance(data, dict):
            result = {}
            for k, v in data.items():
                if k in ("created_at", "generated_at", "timestamp"):
                    result[k] = "2026-01-01T00:00:00Z"
                elif k in ("duration_ms", "query_time_ms"):
                    result[k] = 0.0
                elif k == "request_id":
                    result[k] = "00000000-0000-0000-0000-000000000000"
                else:
                    result[k] = SnapshotSanitizer.sanitize(v)
            return result
        elif isinstance(data, list):
            return sorted([SnapshotSanitizer.sanitize(item) for item in data],
                         key=lambda x: str(x))
        return data

@pytest.fixture
def sanitized_snapshot(snapshot):
    return snapshot

class TestG001MemorySettingsReport:
    """Golden snapshot tests for generate_g001_memory_settings_report()

    Snapshots stored in tests/__snapshots__/
    All snapshot changes require explicit review in MR diff.
    """

    def test_happy_path(self, sanitized_snapshot, mock_prometheus):
        """Normal operation with valid metrics"""
        mock_prometheus.return_value = FIXTURE_NORMAL_METRICS
        result = generator.generate_g001_memory_settings_report()
        sanitized = SnapshotSanitizer.sanitize(result)
        assert sanitized == sanitized_snapshot

    def test_empty_metrics(self, sanitized_snapshot, mock_prometheus):
        """Prometheus returns empty data"""
        mock_prometheus.return_value = {"status": "success", "data": {"result": []}}
        result = generator.generate_g001_memory_settings_report()
        sanitized = SnapshotSanitizer.sanitize(result)
        assert sanitized == sanitized_snapshot

    def test_malformed_input(self, sanitized_snapshot, mock_prometheus):
        """Prometheus returns unexpected structure"""
        mock_prometheus.return_value = {"status": "success", "data": None}
        result = generator.generate_g001_memory_settings_report()
        sanitized = SnapshotSanitizer.sanitize(result)
        assert sanitized == sanitized_snapshot  # Should include error section

    def test_prometheus_unavailable(self, sanitized_snapshot, mock_prometheus):
        """Prometheus connection fails"""
        mock_prometheus.side_effect = requests.exceptions.ConnectionError("connection refused")
        result = generator.generate_g001_memory_settings_report()
        sanitized = SnapshotSanitizer.sanitize(result)
        assert sanitized == sanitized_snapshot  # Should return partial report with error
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
        assert "mean_time" in headers

    def test_rejects_invalid_params(self, client):
        response = client.get("/pgss_metrics/csv?limit=invalid")
        assert response.status_code == 400
        assert response.json["error"]

    def test_handles_db_unavailable(self, client, mock_db_unavailable):
        response = client.get("/pgss_metrics/csv")
        assert response.status_code == 503
        assert "database" in response.json["error"].lower()
```

---

## 5. Error Semantics

### Critical Rule: Do NOT Refactor Python

> **Test Python code AS-IS.** Do not change return signatures from `dict|None` to `ReportResult` just to make it "cleaner" for testing. You risk introducing bugs in code you're about to delete.

**Divergent implementations, convergent vectors:**
- Python test expects `None` or exception (current behavior)
- TS test expects structured `ReportResult` (new design)
- Shared vector: `{"input": "bad_conn", "outcome": "failure"}`

The *behavior* (it failed) is consistent; the *signature* can differ.

### Structured Error Codes (for new TS implementation)

```typescript
// TypeScript only - don't backport to Python
interface ReportError {
  code: string;      // "PROM_UNAVAILABLE", "MALFORMED_RESPONSE", etc.
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}

interface ReportResult {
  data: Record<string, unknown>;
  errors: ReportError[];
  partial: boolean;
}
```

### Expected Behavior Matrix

| Scenario | Python (current) | TypeScript (new) | Vector Outcome |
|----------|------------------|------------------|----------------|
| Prometheus unavailable | Returns `None` | `ReportResult` with `PROM_UNAVAILABLE` error | `"outcome": "failure"` |
| Malformed response | May crash or return partial | `ReportResult` with `MALFORMED_RESPONSE` error | `"outcome": "failure"` |
| Empty metrics | Returns empty dict | `ReportResult` with `no_data: true` | `"outcome": "empty"` |
| Partial success | Undefined | `ReportResult` with `partial: true` + data + errors | `"outcome": "partial"` |

### Partial Report Semantics (TS only)

When some subqueries fail but others succeed:
- Return `partial: true`
- Include all successful data
- Include structured errors for each failure
- Caller decides whether to use partial data

---

## 6. Test Quality Beyond Coverage

### 6.1 Diff Coverage (MR Gate)

Only enforce coverage on **changed lines**:

```yaml
# .gitlab-ci.yml
reporter:diff-coverage:
  stage: test
  script:
    - pytest --cov=reporter --cov-report=xml
    - |
      diff-cover coverage.xml --compare-branch origin/main --fail-under=90 || {
        # If no Python files changed, that's OK
        if diff-cover coverage.xml --compare-branch origin/main 2>&1 | grep -q "No lines found"; then
          echo "No Python lines changed, skipping coverage gate"
          exit 0
        fi
        exit 1
      }
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

### 6.2 Flaky Test Detection

```yaml
# .gitlab-ci.yml - run on MRs only
reporter:flaky-check:
  stage: test
  script:
    - pip install pytest-repeat
    - pytest tests/reporter -m unit --count=3 --repeat-scope=session
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  allow_failure: true
```

### 6.3 Mutation Testing (Optional, Monthly)

> **Note:** Mutation testing is lower priority for migrating code. Property tests + compliance vectors provide similar bug-detection value. Consider running monthly or only on stable modules.

```bash
# Install
pip install mutmut

# Run on P0 functions only (scope narrowly)
mutmut run --paths-to-mutate=reporter/postgres_reports.py \
           --tests-dir=tests/reporter \
           --runner="pytest tests/reporter/test_compliance.py -x"

# Establish baseline first, then set targets
mutmut results
```

---

## 7. CI Optimization

### Avoid Double-Parallelization

**Problem:** Using both GitLab `parallel:` and pytest `-n auto` wastes resources.

**Fix:** Choose one:

```yaml
# Option A: GitLab job parallelization with pytest-split
reporter:tests:unit:
  stage: test
  parallel: 3
  script:
    - pip install pytest-split
    - pytest tests/reporter -m unit --splits=${CI_NODE_TOTAL} --group=${CI_NODE_INDEX}

# Option B: pytest-xdist only (more flexible)
reporter:tests:unit:
  stage: test
  script:
    - pytest tests/reporter -m unit -n auto --dist=loadfile
```

### Cache Keys

```yaml
cache:
  - key:
      files:
        - requirements.txt
        - requirements-dev.txt
    paths:
      - ~/.cache/pip/
  - key:
      files:
        - bun.lockb
    paths:
      - node_modules/
      - ~/.bun/install/cache/
```

### Target CI Times

> Current: ~6min (to be measured). Target: <3min.

| Stage | Target | Method |
|-------|--------|--------|
| Unit tests | <30s | Parallel, no I/O |
| Integration | <60s | Session-scoped DB, template cloning |
| E2E | <90s | Docker layer caching |
| **Total** | <3min | |

---

## 8. TypeScript Migration Constraints

### Decision: Use `number`, Cap at MAX_SAFE_INTEGER

JavaScript `number` is safe up to `2^53 - 1` (9,007,199,254,740,991 bytes ≈ 8 PB).

```typescript
const MAX_SAFE_VALUE = 9007199254740991;

function parseMemoryValue(input: string): number {
  const bytes = parseMemoryValueInternal(input);
  if (bytes > MAX_SAFE_VALUE) {
    throw new Error(`ERR_OVERFLOW: Value ${bytes} exceeds safe integer range`);
  }
  return bytes;
}
```

**Add same constraint to Python for parity:**

```python
MAX_SAFE_VALUE = 9007199254740991  # Sync with TypeScript

def _parse_memory_value(input: str) -> int:
    bytes_val = _parse_memory_value_internal(input)
    if bytes_val > MAX_SAFE_VALUE:
        raise ValueError(f"ERR_OVERFLOW: Value {bytes_val} exceeds safe integer range")
    return bytes_val
```

Include overflow cases in compliance vectors so both implementations align.

---

## 9. Implementation Plan

### Phase 1: Compliance Vectors (Week 1)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Create `tests/compliance_vectors/` structure | TBD | Directory + schema.json |
| Write `memory_parsing.json` | TBD | 20+ cases with IDs and error codes |
| Write `query_id_validation.json` | TBD | 15+ cases |
| Create Python compliance harness | TBD | `test_compliance.py` |
| Add vector schema validation test | TBD | CI passes |

**Definition of Done:** Vectors schema exists, validated in CI, Python harness runs all cases.

### Phase 2: Property Tests + Snapshots (Week 2)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Add Hypothesis + syrupy to requirements | TBD | `requirements-dev.txt` |
| Property tests for `_parse_memory_value` | TBD | 3-5 property tests with CI profile |
| Property tests for `_densify` | TBD | Idempotence test |
| Golden snapshots for G001 | TBD | 4 snapshot files with sanitizer |
| Golden snapshots for K001, K003 | TBD | 4 snapshot files each |

**Definition of Done:** Snapshots reviewed, committed, stable across runs. Sanitizer handles timestamps.

### Phase 3: Error Semantics + Contracts (Week 3)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Document current Python error behavior | TBD | Table in this doc verified |
| Define TS error codes | TBD | Error code enum |
| Flask endpoint contract tests | TBD | 5 endpoints covered |

**Definition of Done:** Error codes standardized, Python behavior documented, contracts tested.

### Phase 4: CI Hardening (Week 4)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Add diff-coverage to MR pipeline | TBD | `.gitlab-ci.yml` |
| Add flaky test detection | TBD | `.gitlab-ci.yml` |
| Add shellcheck for index_pilot | TBD | `.gitlab-ci.yml` |
| Fix parallelization (choose one model) | TBD | `.gitlab-ci.yml` |

**Definition of Done:** CI time <3min, no flaky failures in 10 consecutive runs.

### Stop Condition

> If vectors uncover ambiguous behavior in Python, **decide the spec first** and document it before porting to TS. Do not port ambiguous behavior.

### Phase Dependencies

- Phase 2 can start when `memory_parsing.json` and `test_compliance.py` are merged
- Other vectors can continue in parallel with Phase 2
- Phase 3 can start independently
- Phase 4 requires Phases 1-2 complete

---

## 10. Mocking Guidelines

| Dependency | Unit Tests | Integration Tests |
|-----------|------------|-------------------|
| Prometheus API | Always mock | May use real or mock |
| PostgreSQL | Always mock | Use pytest-postgresql |
| External APIs | Always mock | Always mock |
| File system | Use `pyfakefs` or mock | Real files OK |
| Time/dates | Mock `datetime.now()` | Mock or real |

**Rules:**
- Never mock the code under test
- Prefer dependency injection over `patch()`
- If you need 5+ patches, refactor via constructor injection:

```python
# Instead of patching 5 imports:
class ReportGenerator:
    def __init__(self, prometheus_client, db_connection):
        self.prometheus = prometheus_client
        self.db = db_connection

# Tests just pass mock objects—no patching needed
```

---

## 11. Test Data Management

| Size | Location | Example |
|------|----------|---------|
| Small (< 10 values) | Inline in test | `["a", "b", "c"]` |
| Medium (10-100 values) | `tests/fixtures/` directory | Prometheus response templates |
| Large (> 100 values) | `compliance_vectors/` JSON | Memory parsing cases |
| Generated | Create programmatically | Hypothesis strategies |

**Load helper for fixtures:**

```python
@pytest.fixture
def mock_prom_data(request):
    path = FIXTURE_DIR / f"prometheus/{request.param}.json"
    return json.loads(path.read_text())
```

**Never commit:**
- Large binary fixtures
- Production data (generate synthetic data that *mimics* production patterns)
- Generated coverage reports

---

## 12. Success Criteria

### Quantitative

| Metric | Target | Measured How |
|--------|--------|--------------|
| Compliance vectors pass | 100% | pytest harness |
| Golden snapshots stable | 100% | No unexpected changes |
| Diff coverage on MRs | 90%+ | diff-cover |
| CI time (tests) | <3min | GitLab metrics |
| Flaky test rate | <1% | 100 CI runs |
| P0 function coverage | 95%+ | pytest-cov (secondary metric) |

### Qualitative

- [ ] All P0 functions have compliance vectors with IDs and error codes
- [ ] All report generators have golden snapshots with sanitizers
- [ ] Current Python error behavior documented (not refactored)
- [ ] TS error codes defined
- [ ] Compliance vectors work for both Python and TS harnesses
- [ ] Shellcheck passes for index_pilot

---

## 13. Rollback Plan

If TS migration discovers that Python and TypeScript behave differently in production on edge cases the tests missed:

1. **Do NOT silently diverge** - both implementations must match spec
2. Update compliance vectors to document the **correct** behavior
3. Fix **both** implementations to match the spec
4. Add the edge case to vectors to prevent regression

> "Compliance vectors are the spec. If reality doesn't match the spec, fix reality."

---

## Appendix: Quick Reference

### Commands

```bash
# Run compliance tests
pytest tests/python/test_compliance.py -v

# Validate vector schema
pytest tests/python/test_compliance.py::TestVectorSchemaValid -v

# Run with coverage
pytest --cov=reporter --cov-report=html

# Run property tests (local profile)
pytest tests/reporter -k "property" -v --hypothesis-profile=local

# Update snapshots
pytest --snapshot-update

# Check diff coverage
diff-cover coverage.xml --compare-branch origin/main

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
pytest-socket>=0.6       # Enforce no network in unit tests
jsonschema>=4.0          # Vector schema validation
```

---

*Document version: 2.1*
*Updated: 2026-01-22*
*Focus: Migration safety, test Python as-is, structured error codes*
