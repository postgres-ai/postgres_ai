# Test Coverage Strategy: Path to ~100% Meaningful Coverage

## Executive Summary

This document outlines a strategy to achieve near-100% test coverage with **meaningful tests** that cover positive paths, negative paths, edge cases, and corner cases—while keeping CI execution time reasonable. Special focus is given to Python code (reporter module) in preparation for TypeScript migration.

---

## 1. Current State Analysis

### Coverage Metrics (Current)

| Component | Framework | Estimated Coverage | Test Lines |
|-----------|-----------|-------------------|------------|
| CLI (TypeScript) | Bun test | ~70-75% | 7,640 |
| Reporter (Python) | pytest + pytest-cov | ~60-65% | 2,945 |
| Flask Backend | pytest | ~40-50% | 585 |
| index_pilot (Shell) | Shell scripts | ~50% | N/A |

### Test Infrastructure

- **CLI**: Bun built-in test runner with LCOV coverage
- **Reporter**: pytest with pytest-cov, XML + terminal reports
- **CI**: GitLab CI with coverage badge extraction
- **Test Markers**: `@pytest.mark.unit`, `@pytest.mark.integration`, `@pytest.mark.e2e`

---

## 2. Coverage Goals

### Target Metrics

| Metric | Target | Rationale |
|--------|--------|-----------|
| Line Coverage | 95%+ | Industry standard for critical infrastructure |
| Branch Coverage | 90%+ | Ensures conditional logic is tested |
| Function Coverage | 98%+ | Every function should have at least one test |

### Quality Criteria (Beyond Numbers)

1. **Every function has tests for:**
   - Happy path (normal operation)
   - At least one negative path (error condition)
   - Boundary conditions (edge cases)
   - Invalid inputs (corner cases)

2. **No "coverage padding"** - tests must verify behavior, not just execute code

---

## 3. Python Reporter: Priority Analysis

### Critical Untested Methods (Must Fix First)

| Priority | Method | Lines | Why Critical |
|----------|--------|-------|--------------|
| P0 | `_parse_memory_value()` | 1610-1643 | Parses PostgreSQL memory configs; complex unit logic |
| P0 | `_analyze_memory_settings()` | 1557-1608 | Memory calculation logic; affects recommendations |
| P0 | `generate_g001_memory_settings_report()` | 1471-1555 | Complete report—zero tests |
| P0 | `generate_k001_query_calls_report()` | 1798-1905 | Complete report—zero tests |
| P0 | `generate_k003_top_queries_report()` | 1907-2047 | Complete report—zero tests |
| P1 | `_build_qid_regex()` | 3285-3299 | Query ID validation; security-adjacent |
| P1 | `get_all_nodes()` | 4574-4631 | Node discovery with primary/standby detection |
| P1 | `_get_pgss_metrics_data_by_db()` | 4700-4783 | Complex 84-line metric aggregation |
| P2 | `_densify()` | 3318-3335 | Timeline data filling |
| P2 | `_build_timeline()` | 3270-3283 | Timeline generation |
| P2 | `format_epoch_timestamp()` | 3516-3529 | Timestamp formatting edge cases |

### Well-Tested Methods (Expand Edge Cases)

These have happy-path tests but need negative/edge case expansion:

| Method | Current Tests | Missing |
|--------|---------------|---------|
| `query_instant()` | HTTP errors | Malformed metric names, empty results |
| `query_range()` | HTTP errors | Large time ranges, step size edge cases |
| `format_bytes()` | Parametrized | Negative values, float precision |
| `generate_h002_unused_indexes_report()` | Happy path | Empty index list, malformed data |

### Flask Backend Gaps

| Endpoint | Status | Action |
|----------|--------|--------|
| `/version` | Tested | Expand error cases |
| `/health` | Tested | Add degraded states |
| `/pgss_metrics/csv` | **UNTESTED** | Full test suite needed |
| `/metrics` | **UNTESTED** | Full test suite needed |
| `/btree_bloat/csv` | **UNTESTED** | Full test suite needed |
| `/table_info/csv` | **UNTESTED** | Full test suite needed |
| `/query_texts` | Tested | Edge cases for large queries |
| `/query_info_metrics` | **UNTESTED** | Full test suite needed |

---

## 4. Test Categories and Strategy

### 4.1 Unit Tests (Target: <5s per file)

**Characteristics:**
- No I/O (network, disk, database)
- Pure function testing
- Mocked dependencies
- Run in parallel

**Python Example Structure:**
```python
class TestParseMemoryValue:
    """Unit tests for _parse_memory_value()"""

    # Happy paths
    @pytest.mark.parametrize("input_val,expected", [
        ("128MB", 134217728),
        ("4GB", 4294967296),
        ("1TB", 1099511627776),
        ("8192", 67108864),  # 8KB blocks
    ])
    def test_valid_memory_values(self, input_val, expected):
        assert _parse_memory_value(input_val) == expected

    # Edge cases
    @pytest.mark.parametrize("input_val,expected", [
        ("0", 0),
        ("1", 8192),  # Single 8KB block
        ("0MB", 0),
        ("1B", 1),
    ])
    def test_boundary_values(self, input_val, expected):
        assert _parse_memory_value(input_val) == expected

    # Negative paths
    @pytest.mark.parametrize("input_val", [
        "",
        None,
        "invalid",
        "-1MB",
        "128XB",  # Invalid unit
        "12.5.6GB",  # Malformed
    ])
    def test_invalid_inputs(self, input_val):
        with pytest.raises((ValueError, TypeError)):
            _parse_memory_value(input_val)

    # Corner cases
    @pytest.mark.parametrize("input_val,expected", [
        ("  128MB  ", 134217728),  # Whitespace
        ("128mb", 134217728),      # Lowercase
        ("128Mb", 134217728),      # Mixed case
        ("1.5GB", 1610612736),     # Decimal
    ])
    def test_format_variations(self, input_val, expected):
        assert _parse_memory_value(input_val) == expected
```

### 4.2 Integration Tests (Target: <30s per suite)

**Characteristics:**
- Test component interactions
- May use test databases (PostgreSQL via pytest-postgresql)
- May use HTTP mocking (responses library)
- Run sequentially when needed

**Strategy:**
- Use fixtures for database setup/teardown
- Share database connections across related tests
- Use `@pytest.mark.integration` marker

### 4.3 E2E Tests (Target: <2min per scenario)

**Characteristics:**
- Full stack testing
- Real Docker containers
- Test complete workflows

**Strategy:**
- Run in dedicated CI job
- Parallelize by scenario
- Cache Docker images

---

## 5. Negative Path Testing Strategy

### 5.1 Error Categories to Test

| Category | Examples | Test Approach |
|----------|----------|---------------|
| Network Errors | Timeout, connection refused, DNS failure | Mock with `responses` or `httpx` |
| Invalid Input | Wrong types, out-of-range, malformed | Parametrized tests with invalid data |
| State Errors | Missing config, uninitialized, race conditions | Setup fixtures with broken state |
| Resource Errors | Disk full, OOM, too many connections | Mock resource exhaustion |
| Auth Errors | Expired token, invalid credentials, missing perms | Mock auth responses |

### 5.2 Python Reporter: Specific Negative Tests Needed

```python
# File: tests/reporter/test_negative_paths.py

class TestNetworkErrors:
    """Test behavior when Prometheus/PostgreSQL are unavailable"""

    def test_query_instant_connection_refused(self, mock_prometheus):
        mock_prometheus.side_effect = ConnectionError()
        result = generator.query_instant("metric")
        assert result is None  # Graceful degradation

    def test_query_instant_timeout(self, mock_prometheus):
        mock_prometheus.side_effect = TimeoutError()
        # Should retry or fail gracefully

    def test_sink_connection_failure(self, mock_postgres):
        mock_postgres.side_effect = psycopg2.OperationalError()
        # Should handle without crash

class TestInvalidInput:
    """Test handling of malformed/invalid input data"""

    def test_malformed_prometheus_response(self):
        # Response missing expected fields

    def test_invalid_queryid_format(self):
        # Non-numeric, special chars, SQL injection attempts

    def test_corrupted_settings_data(self):
        # Missing keys, wrong types in A003 data

class TestResourceExhaustion:
    """Test behavior under resource pressure"""

    def test_very_large_query_count(self):
        # 100k+ queries in response

    def test_deeply_nested_json(self):
        # Prevent stack overflow
```

---

## 6. Edge and Corner Case Testing

### 6.1 Edge Case Categories

| Type | Description | Example |
|------|-------------|---------|
| Boundary | At limits of valid ranges | `0`, `MAX_INT`, empty string |
| Empty | Empty collections/strings | `[]`, `{}`, `""` |
| Single | Collections with one item | `[single_item]` |
| Large | Near resource limits | 10k items, 1MB strings |
| Precision | Floating point edge cases | `0.1 + 0.2`, very small numbers |

### 6.2 Python Reporter: Edge Cases to Add

```python
# Memory parsing edge cases
class TestMemoryParsingEdgeCases:
    @pytest.mark.parametrize("value", [
        "0",                    # Zero
        "1",                    # Minimum (1 block = 8KB)
        "9223372036854775807",  # Max int64 blocks
        "1023KB",               # Just under 1MB
        "1024KB",               # Exactly 1MB
        "0.001MB",              # Sub-KB value
    ])
    def test_boundary_memory_values(self, value):
        # Should handle or raise appropriate error
        pass

# Timeline building edge cases
class TestTimelineEdgeCases:
    def test_zero_hour_range(self):
        # start == end

    def test_negative_hours(self):
        # Should reject or handle

    def test_very_large_range(self):
        # 10000 hours

    def test_fractional_step(self):
        # Non-integer step sizes

# Report generation edge cases
class TestReportEdgeCases:
    def test_empty_metrics_response(self):
        # Prometheus returns empty data

    def test_single_datapoint(self):
        # Only one metric sample

    def test_all_null_values(self):
        # All samples are None/NaN

    def test_unicode_in_labels(self):
        # Non-ASCII database names

    def test_special_chars_in_query(self):
        # Queries with quotes, backslashes
```

---

## 7. CI Optimization Strategy

### 7.1 Current CI Pain Points

- Full test suite: ~5-10 minutes
- E2E tests with Docker: ~3-5 minutes
- No test parallelization within jobs

### 7.2 Optimization Techniques

#### A. Test Parallelization

```yaml
# .gitlab-ci.yml improvements
reporter:tests:unit:
  script:
    - pytest tests/ -m "unit" -n auto  # pytest-xdist parallel
  parallel: 3  # Split across 3 runners

reporter:tests:integration:
  script:
    - pytest tests/ -m "integration" -n 2
  needs: [reporter:tests:unit]
```

#### B. Test Splitting by Type

| Job | Tests | Target Time |
|-----|-------|-------------|
| `unit-fast` | All unit tests | <30s |
| `integration` | DB/API integration | <60s |
| `e2e` | Full stack | <120s |

#### C. Caching Strategies

```yaml
cache:
  key: ${CI_COMMIT_REF_SLUG}
  paths:
    - .pytest_cache/
    - .coverage_cache/
    - node_modules/
    - .bun/install/cache/
```

#### D. Smart Test Selection (Future)

```bash
# Only run tests affected by changed files
pytest --collect-only --quiet | \
  python scripts/filter_tests_by_changes.py
```

### 7.3 Target CI Times

| Stage | Current | Target | Method |
|-------|---------|--------|--------|
| Unit Tests | 60s | 30s | Parallelization |
| Integration | 120s | 60s | Better fixtures, caching |
| E2E | 180s | 120s | Docker layer caching |
| **Total** | **6min** | **3.5min** | Combined optimizations |

---

## 8. Implementation Plan

### Phase 1: Foundation (Steps 1-5)

#### Step 1: Add Missing Unit Tests for Core Parsers

**Files to create/modify:**
- `tests/reporter/test_memory_parsing_unit.py` (NEW)
- `tests/reporter/test_timeline_utils_unit.py` (NEW)

**Functions to test:**
- `_parse_memory_value()` - 20+ test cases
- `_analyze_memory_settings()` - 10+ test cases
- `_floor_hour()` - 5 test cases
- `_build_timeline()` - 10 test cases
- `format_epoch_timestamp()` - 8 test cases

**Estimated complexity:** Medium (isolated functions)

#### Step 2: Add Missing Unit Tests for Query ID Handling

**Files to create/modify:**
- `tests/reporter/test_queryid_utils_unit.py` (NEW)

**Functions to test:**
- `_build_qid_regex()` - 15 test cases (including SQL injection attempts)
- `extract_queryids_from_reports()` - expand existing tests

**Estimated complexity:** Low-Medium

#### Step 3: Add Missing Report Generator Tests

**Files to modify:**
- `tests/reporter/test_generators_unit.py` (EXPAND)

**Reports to test:**
- `generate_g001_memory_settings_report()` - 10+ test cases
- `generate_k001_query_calls_report()` - 10+ test cases
- `generate_k003_top_queries_report()` - 10+ test cases

**Estimated complexity:** High (requires understanding report structure)

#### Step 4: Add Negative Path Tests

**Files to create:**
- `tests/reporter/test_error_handling_unit.py` (NEW)

**Scenarios:**
- Network failures (timeout, connection refused, DNS)
- Malformed responses (invalid JSON, missing fields)
- Invalid inputs (wrong types, out of range)
- Resource exhaustion (large payloads)

**Estimated complexity:** Medium

#### Step 5: Add Edge Case Tests

**Files to create:**
- `tests/reporter/test_edge_cases_unit.py` (NEW)

**Scenarios:**
- Empty inputs/outputs
- Boundary values (0, MAX_INT, etc.)
- Unicode handling
- Very large inputs

**Estimated complexity:** Medium

### Phase 2: Flask Backend (Steps 6-7)

#### Step 6: Complete Flask Endpoint Tests

**Files to create/modify:**
- `tests/monitoring_flask_backend/test_endpoints_unit.py` (NEW)

**Endpoints to test:**
- `/pgss_metrics/csv` - 10 test cases
- `/metrics` - 8 test cases
- `/btree_bloat/csv` - 8 test cases
- `/table_info/csv` - 8 test cases
- `/query_info_metrics` - 8 test cases

**Estimated complexity:** Medium

#### Step 7: Flask Error Handling Tests

**Files to create:**
- `tests/monitoring_flask_backend/test_error_handling.py` (NEW)

**Scenarios:**
- Invalid request parameters
- Database connection failures
- Timeout handling
- Rate limiting behavior

**Estimated complexity:** Medium

### Phase 3: Integration & E2E (Steps 8-9)

#### Step 8: Expand Integration Tests

**Files to modify:**
- `tests/reporter/test_postgres_integration.py` (EXPAND)

**Scenarios:**
- Multi-database scenarios
- Primary/standby detection
- Connection pooling behavior
- Concurrent query handling

**Estimated complexity:** High (requires PostgreSQL fixtures)

#### Step 9: Add E2E Workflow Tests

**Files to create:**
- `tests/e2e/test_full_report_workflow.py` (NEW)

**Workflows:**
- Complete report generation cycle
- API upload with authentication
- Error recovery scenarios

**Estimated complexity:** High (requires full stack)

### Phase 4: CI Optimization (Steps 10-11)

#### Step 10: Implement Test Parallelization

**Files to modify:**
- `.gitlab-ci.yml`
- `pytest.ini`

**Changes:**
- Add pytest-xdist for parallel execution
- Split tests into parallel jobs
- Add proper test markers

**Estimated complexity:** Low

#### Step 11: Implement Test Caching

**Files to modify:**
- `.gitlab-ci.yml`

**Changes:**
- Cache pytest artifacts
- Cache pip packages
- Cache Docker layers for E2E

**Estimated complexity:** Low

### Phase 5: Coverage Enforcement (Step 12)

#### Step 12: Add Coverage Thresholds

**Files to modify:**
- `pytest.ini` or `pyproject.toml`
- `.gitlab-ci.yml`

**Changes:**
```ini
# pytest.ini
[pytest]
addopts = --cov=reporter --cov-fail-under=95
```

```yaml
# .gitlab-ci.yml
reporter:tests:
  script:
    - pytest --cov-fail-under=95
  allow_failure: false
```

**Estimated complexity:** Low

---

## 9. Test File Organization

### Proposed Structure

```
tests/
├── reporter/
│   ├── conftest.py                           # Shared fixtures
│   ├── test_generators_unit.py               # Existing + expanded
│   ├── test_generators_hourly_unit.py        # Existing
│   ├── test_generators_query_unit.py         # Existing
│   ├── test_memory_parsing_unit.py           # NEW: Memory parsing
│   ├── test_timeline_utils_unit.py           # NEW: Timeline helpers
│   ├── test_queryid_utils_unit.py            # NEW: Query ID handling
│   ├── test_error_handling_unit.py           # NEW: Negative paths
│   ├── test_edge_cases_unit.py               # NEW: Edge/corner cases
│   ├── test_formatters.py                    # Existing
│   ├── test_report_schemas.py                # Existing
│   ├── test_postgres_integration.py          # Existing + expanded
│   └── test_amp_auth.py                      # Existing
├── monitoring_flask_backend/
│   ├── conftest.py                           # Flask test fixtures
│   ├── test_app.py                           # Existing
│   ├── test_endpoints_unit.py                # NEW: All endpoints
│   └── test_error_handling.py                # NEW: Error cases
└── e2e/
    ├── conftest.py                           # E2E fixtures
    └── test_full_report_workflow.py          # NEW: Full workflows
```

---

## 10. Testing Conventions

### Naming Conventions

```python
# Test class naming
class TestFunctionName:              # For function tests
class TestClassName:                 # For class tests
class TestFeatureScenario:           # For feature tests

# Test method naming
def test_function_happy_path(self):           # Normal operation
def test_function_with_invalid_input(self):   # Negative path
def test_function_at_boundary(self):          # Edge case
def test_function_extreme_conditions(self):   # Corner case
```

### Fixture Conventions

```python
# conftest.py
@pytest.fixture
def mock_prometheus():
    """Mock Prometheus client for unit tests"""
    with patch('reporter.postgres_reports.requests') as mock:
        yield mock

@pytest.fixture
def sample_a003_report():
    """Sample A003 settings report for testing"""
    return {...}

@pytest.fixture(scope="session")
def postgres_connection():
    """Shared PostgreSQL connection for integration tests"""
    # Setup
    yield connection
    # Teardown
```

### Assertion Patterns

```python
# Use specific assertions
assert result == expected                    # Equality
assert result is None                        # Identity
assert "error" in str(exception)             # String containment
assert len(results) == 5                     # Length
assert all(r > 0 for r in results)           # All match
assert any(r.status == "error" for r in results)  # Any match

# Use pytest.raises for exceptions
with pytest.raises(ValueError, match="invalid memory"):
    _parse_memory_value("invalid")

# Use pytest.approx for floats
assert result == pytest.approx(3.14159, rel=1e-5)
```

---

## 11. Migration Considerations (Python → TypeScript)

### Why Tests Help Migration

1. **Behavior Documentation**: Tests document expected behavior
2. **Regression Detection**: Ensures TS version matches Python behavior
3. **Edge Case Capture**: Documents all edge cases before migration

### Test Portability Strategy

```python
# Python test (before migration)
@pytest.mark.parametrize("input_val,expected", [
    ("128MB", 134217728),
    ("4GB", 4294967296),
])
def test_parse_memory_value(input_val, expected):
    assert _parse_memory_value(input_val) == expected
```

```typescript
// TypeScript test (after migration)
describe('parseMemoryValue', () => {
  test.each([
    ['128MB', 134217728],
    ['4GB', 4294967296],
  ])('parses %s as %d', (input, expected) => {
    expect(parseMemoryValue(input)).toBe(expected);
  });
});
```

### Recommended: Shared Test Data

```json
// tests/fixtures/memory_parsing_cases.json
{
  "valid_cases": [
    {"input": "128MB", "expected": 134217728},
    {"input": "4GB", "expected": 4294967296}
  ],
  "invalid_cases": [
    {"input": "", "error": "empty input"},
    {"input": "invalid", "error": "unrecognized format"}
  ]
}
```

Both Python and TypeScript tests can load from the same JSON, ensuring parity.

---

## 12. Success Metrics

### Quantitative

| Metric | Current | Phase 1 | Phase 2 | Final |
|--------|---------|---------|---------|-------|
| Reporter Line Coverage | ~60% | 80% | 90% | 95%+ |
| Reporter Branch Coverage | ~50% | 70% | 85% | 90%+ |
| Flask Coverage | ~40% | 70% | 85% | 95%+ |
| CI Time (tests) | 6min | 5min | 4min | 3.5min |

### Qualitative

- [ ] Every function has at least one positive test
- [ ] Every function has at least one negative test
- [ ] All parsers have boundary value tests
- [ ] All external calls have error handling tests
- [ ] No flaky tests (100% deterministic)
- [ ] Tests run in isolation (no order dependencies)

---

## 13. Quick Reference: Test Commands

```bash
# Run all tests with coverage
pytest --cov=reporter --cov-report=html

# Run only unit tests (fast)
pytest -m unit

# Run only integration tests
pytest -m integration

# Run with verbose output
pytest -v

# Run specific test file
pytest tests/reporter/test_memory_parsing_unit.py

# Run tests matching pattern
pytest -k "memory"

# Run with parallel execution (requires pytest-xdist)
pytest -n auto

# Generate coverage report
pytest --cov=reporter --cov-report=html --cov-report=term
```

---

## Appendix A: Test Case Templates

### Unit Test Template

```python
"""Unit tests for [module/function]."""
import pytest
from reporter.postgres_reports import function_under_test


class TestFunctionUnderTest:
    """Tests for function_under_test()."""

    # === HAPPY PATH TESTS ===

    def test_basic_functionality(self):
        """Test normal operation with valid input."""
        result = function_under_test(valid_input)
        assert result == expected_output

    @pytest.mark.parametrize("input_val,expected", [
        (case1_input, case1_expected),
        (case2_input, case2_expected),
    ])
    def test_various_valid_inputs(self, input_val, expected):
        """Test with multiple valid input variations."""
        assert function_under_test(input_val) == expected

    # === NEGATIVE PATH TESTS ===

    def test_with_none_input(self):
        """Test handling of None input."""
        with pytest.raises(TypeError):
            function_under_test(None)

    def test_with_invalid_type(self):
        """Test handling of wrong input type."""
        with pytest.raises(TypeError):
            function_under_test(123)  # expects string

    # === EDGE CASE TESTS ===

    def test_with_empty_input(self):
        """Test handling of empty input."""
        result = function_under_test("")
        assert result == expected_for_empty

    def test_at_upper_boundary(self):
        """Test at maximum valid value."""
        result = function_under_test(MAX_VALUE)
        assert result == expected_for_max

    # === CORNER CASE TESTS ===

    def test_with_unicode(self):
        """Test handling of Unicode characters."""
        result = function_under_test("value_\u00e9")
        assert result is not None

    def test_with_special_characters(self):
        """Test handling of special characters."""
        result = function_under_test("value with 'quotes' and \"doubles\"")
        # Assert appropriate handling
```

### Integration Test Template

```python
"""Integration tests for [component]."""
import pytest


@pytest.mark.integration
class TestComponentIntegration:
    """Integration tests requiring real services."""

    @pytest.fixture(autouse=True)
    def setup(self, postgres_connection):
        """Set up test database state."""
        self.conn = postgres_connection
        # Setup test data
        yield
        # Cleanup

    def test_database_query_execution(self):
        """Test actual database query."""
        result = component.query_database(self.conn)
        assert result is not None

    def test_connection_recovery(self):
        """Test recovery from connection failure."""
        # Simulate connection drop
        # Verify recovery behavior
```

---

## Appendix B: Common Test Data

### PostgreSQL Version Strings

```python
POSTGRES_VERSIONS = [
    "PostgreSQL 14.0",
    "PostgreSQL 15.4 (Ubuntu 15.4-1.pgdg22.04+1)",
    "PostgreSQL 16.1 on x86_64-pc-linux-gnu",
    "PostgreSQL 17.0beta1",
]
```

### Memory Value Test Cases

```python
MEMORY_VALUES = {
    "valid": [
        ("128MB", 134217728),
        ("4GB", 4294967296),
        ("1TB", 1099511627776),
        ("64kB", 65536),
        ("8192", 67108864),  # 8KB blocks
    ],
    "invalid": [
        ("", ValueError),
        ("invalid", ValueError),
        ("-1MB", ValueError),
        ("128XB", ValueError),
    ],
    "edge": [
        ("0", 0),
        ("1", 8192),
        ("0.5GB", 536870912),
    ],
}
```

### Prometheus Response Templates

```python
PROM_RESPONSE_SUCCESS = {
    "status": "success",
    "data": {
        "resultType": "vector",
        "result": [
            {"metric": {"__name__": "test"}, "value": [1234567890, "42"]}
        ]
    }
}

PROM_RESPONSE_EMPTY = {
    "status": "success",
    "data": {"resultType": "vector", "result": []}
}

PROM_RESPONSE_ERROR = {
    "status": "error",
    "errorType": "bad_data",
    "error": "invalid query"
}
```

---

*Document created: 2026-01-23*
*Target: Near-100% meaningful test coverage with optimized CI*
