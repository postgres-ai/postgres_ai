"""
PostgresAI Express Checkup - Python SDK

A lightweight library for running PostgreSQL health checks directly from Python.
Works standalone or integrates with Django/Flask/SQLAlchemy.

Usage:
    from postgresai_checkup import Checkup

    # Standalone
    checkup = Checkup("postgresql://user:pass@localhost:5432/mydb")
    reports = checkup.run_all()

    # With Django
    from django.db import connection
    checkup = Checkup.from_django_connection(connection)
    reports = checkup.run_all()
"""

from .checkup import Checkup, CheckResult
from .checks import AVAILABLE_CHECKS

__version__ = "0.1.0"
__all__ = ["Checkup", "CheckResult", "AVAILABLE_CHECKS"]
