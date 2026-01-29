"""
Django integration for PostgresAI Express Checkup.

Usage in Django project:

1. Add to INSTALLED_APPS (optional, for management command):
   INSTALLED_APPS = [
       ...
       'postgresai_checkup.django_app',
   ]

2. Run checks:
   python manage.py pgai_checkup
   python manage.py pgai_checkup --check-id H002
   python manage.py pgai_checkup --output json

3. Programmatic usage:
   from postgresai_checkup.django import run_checkup
   results = run_checkup()
"""

from typing import Dict, Optional
from .checkup import Checkup, CheckResult


def get_checkup(using: str = 'default') -> Checkup:
    """
    Get a Checkup instance using Django's database connection.

    Args:
        using: Database alias (default: 'default')

    Returns:
        Checkup instance connected to the Django database
    """
    from django.db import connections
    connection = connections[using]
    # Ensure connection is established
    connection.ensure_connection()
    return Checkup.from_django_connection(connection)


def run_checkup(
    check_id: Optional[str] = None,
    using: str = 'default'
) -> Dict[str, CheckResult]:
    """
    Run health checks using Django's database connection.

    Args:
        check_id: Specific check to run (None = run all)
        using: Database alias

    Returns:
        Dictionary of check results
    """
    checkup = get_checkup(using=using)
    if check_id:
        return {check_id: checkup.run_check(check_id)}
    return checkup.run_all()


# Django Management Command
# Save as: yourapp/management/commands/pgai_checkup.py

MANAGEMENT_COMMAND_CODE = '''
"""
Django management command for PostgresAI health checks.

Usage:
    python manage.py pgai_checkup
    python manage.py pgai_checkup --check-id H002
    python manage.py pgai_checkup --output json
    python manage.py pgai_checkup --database other_db
"""

from django.core.management.base import BaseCommand
from postgresai_checkup.django import run_checkup
from postgresai_checkup.checks import AVAILABLE_CHECKS
import json


class Command(BaseCommand):
    help = "Run PostgresAI health checks on the database"

    def add_arguments(self, parser):
        parser.add_argument(
            '--check-id',
            type=str,
            help='Run specific check (e.g., H002)',
        )
        parser.add_argument(
            '--database',
            type=str,
            default='default',
            help='Database alias to check',
        )
        parser.add_argument(
            '--output',
            type=str,
            choices=['text', 'json'],
            default='text',
            help='Output format',
        )
        parser.add_argument(
            '--list',
            action='store_true',
            help='List available checks',
        )

    def handle(self, *args, **options):
        if options['list']:
            self.stdout.write("Available checks:")
            for check_id, info in AVAILABLE_CHECKS.items():
                self.stdout.write(f"  {check_id}: {info['title']}")
            return

        check_id = options.get('check_id')
        database = options['database']
        output_format = options['output']

        self.stdout.write(f"Running PostgresAI health checks on '{database}'...")

        try:
            results = run_checkup(check_id=check_id, using=database)
        except Exception as e:
            self.stderr.write(self.style.ERROR(f"Error: {e}"))
            return

        if output_format == 'json':
            output = {k: v.to_dict() for k, v in results.items()}
            self.stdout.write(json.dumps(output, indent=2, default=str))
        else:
            for cid, result in results.items():
                self.stdout.write(self.style.SUCCESS(f"\\n=== {cid}: {result.check_title} ==="))
                if result.error:
                    self.stdout.write(self.style.ERROR(f"Error: {result.error}"))
                else:
                    # Print summary based on check type
                    self._print_summary(cid, result)

    def _print_summary(self, check_id: str, result):
        data = result.data
        if check_id in ('H001', 'H002', 'H004'):
            for db_name, db_data in data.items():
                count = db_data.get('total_count', 0)
                size = db_data.get('total_size_pretty', '0 B')
                self.stdout.write(f"  Database: {db_name}")
                self.stdout.write(f"  Found: {count} items ({size})")
        elif check_id == 'F004':
            for db_name, db_data in data.items():
                count = db_data.get('total_count', 0)
                bloat = db_data.get('total_bloat_size_pretty', '0 B')
                self.stdout.write(f"  Database: {db_name}")
                self.stdout.write(f"  Tables analyzed: {count}")
                self.stdout.write(f"  Estimated bloat: {bloat}")
        elif check_id == 'A002':
            version_info = data.get('version', {})
            self.stdout.write(f"  Version: {version_info.get('version', 'unknown')}")
'''
