# Test Coverage Strategy: Regression Safety for TypeScript Migration

| Version | Date | Changes |
|---------|------|---------|
| 2.0 | 2026-01-22 | Major rewrite based on 3 reviewer feedback: migration-first approach, risk-based coverage tiers, compliance vectors, property testing, golden snapshots, error semantics, CI fixes |
| 1.0 | 2026-01-22 | Initial draft: comprehensive coverage strategy with 12-step implementation plan |

---

## Executive Summary

This document outlines a **migration-first testing strategy** focused on **behavioral documentation** rather than coverage metrics. The goal is **100% regression safety for the TypeScript migration**, not vanity coverage numbers.

**Key Principles:**
1. **Meaningful coverage** = tests that verify behavior and would fail if implementation breaks
2. **Language-agnostic test vectors** = JSON fixtures shared between Python and TypeScript
3. **Don't gold-plate Python** = skip P2/P3 tests for code being migrated soon
4. **Prove tests catch bugs** = mutation testing over line coverage
5. **Define error semantics** = explicit failure modes, not silent `None` returns

---

## 1. Current State (Measured)

### Action Required: Get Actual Numbers

Before proceeding, run actual coverage reports:

```bash
# Python reporter
pytest --cov=reporter --cov-report=term-missing --cov-report=xml

# CLI (TypeScript)
bun test --coverage

# Extract diff coverage for MRs
pip install diff-cover
diff-cover coverage.xml --compare-branch origin/main
```

### Coverage Targets by Risk Tier

Not all code needs 95% coverage. Tier by criticality:

| Tier | Components | Line Target | Branch Target | Rationale |
|------|-----------|-------------|---------------|-----------|
| **Critical** | Memory parsing, query handling, report generators | 95%+ | 90%+ | Affects customer databases |
| **High** | API endpoints, data formatting | 85%+ | 80%+ | User-facing, recoverable errors |
| **Medium** | Internal utilities, CLI wiring | 75%+ | 70%+ | Lower risk, tested via integration |
| **Low/Skip** | Shell scripts (index_pilot) | N/A | N/A | Rewrite in Go/TS or accept risk |

### Shell Script Decision

**Do NOT write shell tests.** Choose one:
1. **Rewrite `index_pilot` in Python/Go/TypeScript** as part of this sprint
2. **Accept the risk** and test only via E2E scenarios

Testing Bash with `shunit2`/`bats` is painful and provides false confidence.

---

## 2. Migration-First Testing Strategy

### The "Rosetta Stone" Approach

Instead of writing Python-specific tests, create **language-agnostic test vectors**:

```
tests/
├── compliance_vectors/           # Shared JSON test data
│   ├── memory_parsing.json
│   ├── query_id_validation.json
│   ├── timeline_generation.json
│   └── report_snapshots/
│       ├── g001_happy_path.json
│       ├── g001_empty_input.json
│       └── ...
├── python/                       # Python test harness
│   └── test_compliance.py
└── typescript/                   # TS test harness (future)
    └── compliance.test.ts
```

### Test Vector Format

```json
// tests/compliance_vectors/memory_parsing.json
{
  "spec_version": "1.0",
  "function": "reporter.postgres_reports._parse_memory_value",
  "description": "Parses PostgreSQL memory configuration strings to bytes",

  "constraints": {
    "max_safe_value": 9007199254740991,  // Number.MAX_SAFE_INTEGER for TS
    "note": "Values above this require bigint in TypeScript"
  },

  "valid_cases": [
    {"input": "128MB", "expected": 134217728, "note": "128 * 1024 * 1024"},
    {"input": "4GB", "expected": 4294967296, "note": "4 * 1024^3"},
    {"input": "1TB", "expected": 1099511627776},
    {"input": "64kB", "expected": 65536},
    {"input": "8192", "expected": 67108864, "note": "8KB blocks: 8192 * 8192"}
  ],

  "boundary_cases": [
    {"input": "0", "expected": 0},
    {"input": "1", "expected": 8192, "note": "minimum 1 block"},
    {"input": "1B", "expected": 1},
    {"input": "1023KB", "expected": 1047552, "note": "just under 1MB"},
    {"input": "1024KB", "expected": 1048576, "note": "exactly 1MB"}
  ],

  "format_variations": [
    {"input": "  128MB  ", "expected": 134217728, "note": "whitespace"},
    {"input": "128mb", "expected": 134217728, "note": "lowercase"},
    {"input": "128Mb", "expected": 134217728, "note": "mixed case"},
    {"input": "1.5GB", "expected": 1610612736, "note": "decimal"}
  ],

  "invalid_cases": [
    {"input": "", "error_type": "ValueError", "error_contains": "empty"},
    {"input": null, "error_type": "TypeError"},
    {"input": "invalid", "error_type": "ValueError", "error_contains": "unrecognized"},
    {"input": "-1MB", "error_type": "ValueError", "error_contains": "negative"},
    {"input": "128XB", "error_type": "ValueError", "error_contains": "unit"}
  ]
}
```

### Python Compliance Harness

```python
# tests/python/test_compliance.py
import json
import pytest
from pathlib import Path
from reporter.postgres_reports import _parse_memory_value

VECTORS_DIR = Path(__file__).parent.parent / "compliance_vectors"

def load_vectors(name: str) -> dict:
    return json.loads((VECTORS_DIR / f"{name}.json").read_text())

class TestMemoryParsingCompliance:
    """Tests loaded from compliance_vectors/memory_parsing.json"""

    vectors = load_vectors("memory_parsing")

    @pytest.mark.parametrize("case", vectors["valid_cases"], ids=lambda c: c["input"])
    def test_valid_cases(self, case):
        assert _parse_memory_value(case["input"]) == case["expected"]

    @pytest.mark.parametrize("case", vectors["boundary_cases"], ids=lambda c: c["input"])
    def test_boundary_cases(self, case):
        assert _parse_memory_value(case["input"]) == case["expected"]

    @pytest.mark.parametrize("case", vectors["format_variations"], ids=lambda c: c["input"])
    def test_format_variations(self, case):
        assert _parse_memory_value(case["input"]) == case["expected"]

    @pytest.mark.parametrize("case", vectors["invalid_cases"], ids=lambda c: str(c["input"]))
    def test_invalid_cases(self, case):
        error_type = getattr(__builtins__, case["error_type"])
        with pytest.raises(error_type) as exc:
            _parse_memory_value(case["input"])
        if "error_contains" in case:
            assert case["error_contains"] in str(exc.value).lower()
```

### TypeScript Compliance Harness (Future)

```typescript
// tests/typescript/compliance.test.ts
import { describe, test, expect } from 'bun:test';
import memoryVectors from '../compliance_vectors/memory_parsing.json';
import { parseMemoryValue } from '../../lib/memory';

describe('Memory Parsing Compliance', () => {
  test.each(memoryVectors.valid_cases)('parses $input', (c) => {
    expect(parseMemoryValue(c.input)).toBe(c.expected);
  });

  test.each(memoryVectors.invalid_cases)('rejects $input', (c) => {
    expect(() => parseMemoryValue(c.input)).toThrow();
  });
});
```

---

## 3. Priority Analysis (Migration-Adjusted)

### Priority Definitions

| Priority | Definition | Action |
|----------|-----------|--------|
| **P0** | Untested code with complex logic that affects customer data | Write compliance vectors + property tests |
| **P1** | Untested code that could silently fail | Write compliance vectors |
| **P2** | Partially tested code being migrated soon | **SKIP** - accept current coverage |
| **P3** | Well-tested code | **SKIP** - don't expand |

### P0: Must Test (Complex Logic)

| Function | Module Path | Test Approach |
|----------|-------------|---------------|
| `_parse_memory_value()` | `reporter.postgres_reports` | Compliance vectors + Hypothesis |
| `_analyze_memory_settings()` | `reporter.postgres_reports` | Compliance vectors |
| `generate_g001_memory_settings_report()` | `reporter.postgres_reports` | Golden snapshots (4 cases) |
| `generate_k001_query_calls_report()` | `reporter.postgres_reports` | Golden snapshots (4 cases) |
| `generate_k003_top_queries_report()` | `reporter.postgres_reports` | Golden snapshots (4 cases) |
| `_build_qid_regex()` | `reporter.postgres_reports` | Compliance vectors + security cases |
| `get_all_nodes()` | `reporter.postgres_reports` | Contract test with mock |

### P1: Should Test (Silent Failure Risk)

| Function | Module Path | Test Approach |
|----------|-------------|---------------|
| `_get_pgss_metrics_data_by_db()` | `reporter.postgres_reports` | Compliance vectors |
| `_densify()` | `reporter.postgres_reports` | Property test (idempotent) |
| `_build_timeline()` | `reporter.postgres_reports` | Compliance vectors |
| Flask CSV endpoints | `monitoring_flask_backend.app` | Contract tests |

### P2/P3: Skip for Now

Do **NOT** add tests for:
- `format_epoch_timestamp()` - low risk, being migrated
- `_floor_hour()` - trivial, being migrated
- `filter_a003_settings()` - well-tested via integration
- Expanding edge cases on already-tested methods

---

## 4. Testing Techniques

### 4.1 Property-Based Testing (Hypothesis)

For parsers and pure functions, use Hypothesis instead of manual parametrization:

```python
from hypothesis import given, strategies as st, assume

class TestMemoryParsingProperties:
    """Property-based tests that find edge cases automatically"""

    @given(st.integers(min_value=0, max_value=2**53))  # TS-safe range
    def test_roundtrip_bytes_to_formatted_and_back(self, value):
        """Parsing formatted bytes should return original value"""
        formatted = format_bytes(value)  # "128 MB"
        # Skip if format_bytes doesn't produce parseable output
        assume("B" in formatted or "KB" in formatted or "MB" in formatted or "GB" in formatted)
        parsed = _parse_memory_value(formatted.replace(" ", ""))
        assert parsed == value

    @given(st.text())
    def test_never_crashes_on_arbitrary_input(self, text):
        """Should raise ValueError, never crash"""
        try:
            result = _parse_memory_value(text)
            assert isinstance(result, int)
            assert result >= 0
        except (ValueError, TypeError):
            pass  # Expected for invalid input

    @given(st.integers(min_value=0))
    def test_densify_is_idempotent(self, seed):
        """densify(densify(x)) == densify(x)"""
        timeline = _build_timeline(seed % 100, 3600)
        series = {"test": [(t, seed) for t in timeline[:5]]}

        result1 = _densify(series, timeline)
        result2 = _densify(result1, timeline)
        assert result1 == result2
```

### 4.2 Golden Snapshot Tests (Report Generators)

For report generators, use **4 golden tests per report**, not 10+ manual cases:

```python
import pytest
from syrupy import SnapshotAssertion

class TestG001MemorySettingsReport:
    """Golden snapshot tests for generate_g001_memory_settings_report()"""

    def test_happy_path(self, snapshot: SnapshotAssertion, mock_prometheus):
        """Normal operation with valid metrics"""
        mock_prometheus.return_value = FIXTURE_NORMAL_METRICS
        result = generator.generate_g001_memory_settings_report()
        assert result == snapshot

    def test_empty_metrics(self, snapshot: SnapshotAssertion, mock_prometheus):
        """Prometheus returns empty data"""
        mock_prometheus.return_value = {"status": "success", "data": {"result": []}}
        result = generator.generate_g001_memory_settings_report()
        assert result == snapshot

    def test_malformed_input(self, snapshot: SnapshotAssertion, mock_prometheus):
        """Prometheus returns unexpected structure"""
        mock_prometheus.return_value = {"status": "success", "data": None}
        result = generator.generate_g001_memory_settings_report()
        assert result == snapshot  # Should include error section

    def test_prometheus_unavailable(self, snapshot: SnapshotAssertion, mock_prometheus):
        """Prometheus connection fails"""
        mock_prometheus.side_effect = PrometheusUnavailableError("connection refused")
        result = generator.generate_g001_memory_settings_report()
        assert result == snapshot  # Should return partial report with error
```

**Workflow:**
1. Run tests first time → snapshots created in `__snapshots__/`
2. Review snapshots manually (are these correct behaviors?)
3. Commit snapshots as "gold master"
4. Future runs compare against snapshots
5. If logic changes intentionally, update snapshots with `pytest --snapshot-update`

### 4.3 Contract Tests (Flask Endpoints)

```python
class TestPgssMetricsCsvEndpoint:
    """Contract tests for /pgss_metrics/csv"""

    def test_returns_csv_content_type(self, client):
        response = client.get("/pgss_metrics/csv")
        assert response.content_type == "text/csv; charset=utf-8"

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
        assert response.json["error"]  # Has error message

    def test_handles_db_unavailable(self, client, mock_db_unavailable):
        response = client.get("/pgss_metrics/csv")
        assert response.status_code == 503
        assert "database" in response.json["error"].lower()
```

---

## 5. Error Semantics (Define Before Testing)

Before writing tests, define what **should** happen on failure:

### Report Generation Errors

| Scenario | Current Behavior | Correct Behavior |
|----------|-----------------|------------------|
| Prometheus unavailable | Returns `None` | Returns partial report with `errors` array |
| Malformed response | Crashes | Returns partial report with `errors` array |
| Empty metrics | Returns empty report | Returns report with `"no_data": true` flag |

**Implementation:**

```python
@dataclass
class ReportResult:
    data: dict
    errors: list[str] = field(default_factory=list)
    partial: bool = False

def generate_g001_memory_settings_report() -> ReportResult:
    errors = []
    try:
        metrics = query_prometheus(...)
    except PrometheusUnavailableError as e:
        errors.append(f"prometheus_unavailable: {e}")
        metrics = {}

    # Continue with partial data
    return ReportResult(
        data=build_report(metrics),
        errors=errors,
        partial=bool(errors)
    )
```

### Query Functions

| Function | On Error | Return Type |
|----------|----------|-------------|
| `query_instant()` | Raise `PrometheusError` | `dict` or raises |
| `query_range()` | Raise `PrometheusError` | `dict` or raises |
| `get_all_nodes()` | Raise `DiscoveryError` | `list[Node]` or raises |

**Do NOT return `None` for errors** - it hides problems.

---

## 6. Test Quality Beyond Coverage

### 6.1 Mutation Testing

Line coverage doesn't prove tests catch bugs. Add mutation testing:

```bash
# Install
pip install mutmut

# Run on P0 modules only (slow, so scope it)
mutmut run --paths-to-mutate=reporter/postgres_reports.py \
           --tests-dir=tests/reporter \
           --runner="pytest tests/reporter/test_memory_parsing.py -x"

# View results
mutmut results
```

**Target:** 80%+ mutation score on P0 functions (killed mutants / total mutants).

Run monthly or on major changes, not on every CI pipeline.

### 6.2 Diff Coverage (MR Gate)

Only enforce coverage on **changed lines**:

```yaml
# .gitlab-ci.yml
reporter:diff-coverage:
  stage: test
  script:
    - pytest --cov=reporter --cov-report=xml
    - diff-cover coverage.xml --compare-branch origin/main --fail-under=90
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

This prevents coverage regression without requiring 95% on legacy code.

### 6.3 Flaky Test Detection

```yaml
# .gitlab-ci.yml - run on MRs only
reporter:flaky-check:
  stage: test
  script:
    - pytest tests/reporter -m unit --count=3 -x  # Run each test 3x
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  allow_failure: true  # Alert but don't block
```

---

## 7. CI Optimization

### Avoid Double-Parallelization

**Problem:** Using both GitLab `parallel:` and pytest `-n auto` wastes resources.

**Fix:** Choose one:

```yaml
# Option A: GitLab job parallelization (simpler)
reporter:tests:unit:
  stage: test
  parallel: 3
  script:
    - pytest tests/reporter -m unit --junitxml=report.xml
      $([[ "$CI_NODE_INDEX" ]] && echo "--splits=$CI_NODE_TOTAL --group=$CI_NODE_INDEX")

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
      - .venv/
  - key:
      files:
        - bun.lockb
    paths:
      - node_modules/
      - ~/.bun/install/cache/
```

### Target CI Times

| Stage | Target | Method |
|-------|--------|--------|
| Unit tests | <30s | Parallel, no I/O |
| Integration | <60s | Session-scoped DB, template cloning |
| E2E | <90s | Docker layer caching |
| **Total** | <3min | |

---

## 8. TypeScript Migration Constraints

### Decide Now: bigint vs number

JavaScript `number` is safe up to `2^53 - 1` (9,007,199,254,740,991 bytes ≈ 8 PB).

**Decision:** Use `number` for memory values. Cap at `Number.MAX_SAFE_INTEGER`:

```typescript
function parseMemoryValue(input: string): number {
  const bytes = parseMemoryValueInternal(input);
  if (bytes > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Value ${bytes} exceeds safe integer range`);
  }
  return bytes;
}
```

**Add constraint to compliance vectors:**

```json
{
  "constraints": {
    "max_safe_value": 9007199254740991,
    "behavior_on_overflow": "throw"
  }
}
```

---

## 9. Implementation Plan

### Phase 1: Compliance Vectors (Week 1)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Create `tests/compliance_vectors/` structure | - | Directory + README |
| Write `memory_parsing.json` | - | 20+ test cases |
| Write `query_id_validation.json` | - | 15+ test cases |
| Write `timeline_generation.json` | - | 10+ test cases |
| Create Python compliance harness | - | `test_compliance.py` |

### Phase 2: Property Tests + Snapshots (Week 2)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Add Hypothesis to requirements | - | `requirements-dev.txt` |
| Property tests for `_parse_memory_value` | - | 5 property tests |
| Property tests for `_densify` | - | Idempotence test |
| Golden snapshots for G001 | - | 4 snapshot files |
| Golden snapshots for K001 | - | 4 snapshot files |
| Golden snapshots for K003 | - | 4 snapshot files |

### Phase 3: Error Semantics + Contracts (Week 3)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Define `ReportResult` dataclass | - | Type in `postgres_reports.py` |
| Refactor report generators to use it | - | No behavior change |
| Add error handling tests | - | Tests for each error path |
| Flask endpoint contract tests | - | 5 endpoints covered |

### Phase 4: CI Hardening (Week 4)

| Task | Owner | Deliverable |
|------|-------|-------------|
| Add diff-coverage to MR pipeline | - | `.gitlab-ci.yml` |
| Add flaky test detection | - | `.gitlab-ci.yml` |
| Fix parallelization (choose one model) | - | `.gitlab-ci.yml` |
| Add mutation testing job (manual) | - | `.gitlab-ci.yml` |

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
- If you need 5+ patches, refactor the code

---

## 11. Test Data Management

| Size | Location | Example |
|------|----------|---------|
| Small (< 10 values) | Inline in test | `["a", "b", "c"]` |
| Medium (10-100 values) | `conftest.py` fixture | Prometheus response templates |
| Large (> 100 values) | `compliance_vectors/` JSON | Memory parsing cases |
| Generated | Create programmatically | Hypothesis strategies |

**Never commit:**
- Large binary fixtures
- Production data (even anonymized)
- Generated coverage reports

---

## 12. Success Criteria

### Quantitative

| Metric | Target | Measured How |
|--------|--------|--------------|
| P0 function coverage | 95%+ | pytest-cov |
| P0 mutation score | 80%+ | mutmut (monthly) |
| Diff coverage on MRs | 90%+ | diff-cover |
| CI time (tests) | <3min | GitLab metrics |
| Flaky test rate | 0% | 3x repeat runs |

### Qualitative

- [ ] All P0 functions have compliance vectors
- [ ] All report generators have golden snapshots
- [ ] Error semantics documented and tested
- [ ] No silent `None` returns on errors
- [ ] TS migration constraints defined
- [ ] Compliance vectors work for both Python and TS

---

## Appendix: Quick Reference

### Commands

```bash
# Run compliance tests
pytest tests/python/test_compliance.py -v

# Run with coverage
pytest --cov=reporter --cov-report=html

# Run property tests
pytest tests/reporter -k "property" -v

# Update snapshots
pytest --snapshot-update

# Run mutation testing (slow)
mutmut run --paths-to-mutate=reporter/postgres_reports.py

# Check diff coverage
diff-cover coverage.xml --compare-branch origin/main
```

### New Dependencies

```
# requirements-dev.txt
hypothesis>=6.0
syrupy>=4.0
mutmut>=3.0
diff-cover>=8.0
pytest-socket>=0.6  # Enforce no network in unit tests
```

---

*Document version: 2.0*
*Updated: 2026-01-22*
*Focus: Migration safety over coverage metrics*
