"""Root conftest.py for pytest configuration."""
import os
import pytest


# Configure pytest-postgresql to find PostgreSQL binaries in CI (Debian)
def get_postgresql_bindir():
    """Find PostgreSQL binary directory."""
    for version in ["16", "15", "14", "13", "12", "11"]:
        path = f"/usr/lib/postgresql/{version}/bin"
        if os.path.exists(path):
            return path
    return None


pg_bindir = get_postgresql_bindir()
if pg_bindir:
    os.environ["PATH"] = f"{pg_bindir}:{os.environ.get('PATH', '')}"


def pytest_addoption(parser):
    """Add custom command line options."""
    parser.addoption(
        "--run-integration",
        action="store_true",
        default=False,
        help="Run integration tests that require real services",
    )


def pytest_configure(config):
    """Configure pytest with custom markers and options."""
    config.addinivalue_line(
        "markers", "integration: mark test as integration test requiring real services"
    )


def pytest_collection_modifyitems(config, items):
    """Modify test collection based on command line options."""
    if config.getoption("--run-integration"):
        return

    skip_integration = pytest.mark.skip(reason="need --run-integration option to run")
    for item in items:
        if "integration" in item.keywords or "requires_postgres" in item.keywords:
            item.add_marker(skip_integration)
