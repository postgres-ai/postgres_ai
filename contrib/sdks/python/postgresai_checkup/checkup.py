"""
Core checkup functionality for PostgreSQL health checks.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Union
import json

try:
    import psycopg2
    from psycopg2.extensions import connection as PsycopgConnection
except ImportError:
    psycopg2 = None
    PsycopgConnection = None

try:
    import psycopg
    from psycopg import Connection as Psycopg3Connection
except ImportError:
    psycopg = None
    Psycopg3Connection = None


@dataclass
class PostgresVersion:
    """PostgreSQL version information."""
    version: str
    server_version_num: int
    major: int
    minor: int


@dataclass
class CheckResult:
    """Result of a single health check."""
    check_id: str
    check_title: str
    timestamp: str
    data: Dict[str, Any]
    postgres_version: Optional[PostgresVersion] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary matching JSON schema."""
        return {
            "checkId": self.check_id,
            "checkTitle": self.check_title,
            "timestamptz": self.timestamp,
            "generation_mode": "express",
            "nodes": {"primary": "node-01", "standbys": []},
            "results": {
                "node-01": {
                    "data": self.data,
                    **({"postgres_version": {
                        "version": self.postgres_version.version,
                        "server_version_num": str(self.postgres_version.server_version_num),
                        "server_major_ver": str(self.postgres_version.major),
                        "server_minor_ver": str(self.postgres_version.minor),
                    }} if self.postgres_version else {}),
                    **({"error": self.error} if self.error else {}),
                }
            }
        }

    def to_json(self, indent: int = 2) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), indent=indent, default=str)


def format_bytes(size_bytes: int) -> str:
    """Format bytes to human-readable string (IEC binary units)."""
    if size_bytes == 0:
        return "0 B"
    units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
    i = 0
    size = float(size_bytes)
    while size >= 1024 and i < len(units) - 1:
        size /= 1024
        i += 1
    return f"{size:.2f} {units[i]}"


class Checkup:
    """
    PostgreSQL health check runner.

    Can be initialized with:
    - Connection string: Checkup("postgresql://...")
    - psycopg2 connection: Checkup(conn)
    - psycopg3 connection: Checkup(conn)
    - Django connection: Checkup.from_django_connection(connection)
    """

    def __init__(
        self,
        connection: Union[str, "PsycopgConnection", "Psycopg3Connection", Any],
        node_name: str = "node-01"
    ):
        self._conn_input = connection
        self._conn = None
        self._owns_connection = False
        self._node_name = node_name
        self._pg_version: Optional[PostgresVersion] = None

    @classmethod
    def from_django_connection(cls, django_connection) -> "Checkup":
        """Create Checkup from Django database connection."""
        # Get the underlying psycopg2/psycopg connection
        return cls(django_connection.connection)

    @classmethod
    def from_sqlalchemy_engine(cls, engine) -> "Checkup":
        """Create Checkup from SQLAlchemy engine."""
        return cls(engine.raw_connection())

    def _get_connection(self):
        """Get or create database connection."""
        if self._conn is not None:
            return self._conn

        if isinstance(self._conn_input, str):
            # Connection string - create new connection
            if psycopg2:
                self._conn = psycopg2.connect(self._conn_input)
                self._owns_connection = True
            elif psycopg:
                self._conn = psycopg.connect(self._conn_input)
                self._owns_connection = True
            else:
                raise ImportError("No PostgreSQL driver found. Install psycopg2 or psycopg.")
        else:
            # Assume it's already a connection object
            self._conn = self._conn_input
            self._owns_connection = False

        return self._conn

    def _execute(self, sql: str) -> List[Dict[str, Any]]:
        """Execute SQL and return results as list of dicts."""
        conn = self._get_connection()

        # Handle both psycopg2 and psycopg3 APIs
        if hasattr(conn, 'cursor'):
            with conn.cursor() as cur:
                cur.execute(sql)
                if cur.description:
                    columns = [desc[0] for desc in cur.description]
                    return [dict(zip(columns, row)) for row in cur.fetchall()]
                return []
        else:
            raise TypeError(f"Unsupported connection type: {type(conn)}")

    def get_postgres_version(self) -> PostgresVersion:
        """Get PostgreSQL version information."""
        if self._pg_version:
            return self._pg_version

        rows = self._execute("""
            SELECT name, setting
            FROM pg_settings
            WHERE name IN ('server_version', 'server_version_num')
        """)

        version = ""
        version_num = 0
        for row in rows:
            if row['name'] == 'server_version':
                version = row['setting']
            elif row['name'] == 'server_version_num':
                version_num = int(row['setting'])

        major = version_num // 10000
        minor = version_num % 10000

        self._pg_version = PostgresVersion(
            version=version,
            server_version_num=version_num,
            major=major,
            minor=minor
        )
        return self._pg_version

    def get_current_database(self) -> Dict[str, Any]:
        """Get current database name and size."""
        rows = self._execute("""
            SELECT
                current_database() as datname,
                pg_database_size(current_database()) as size_bytes
        """)
        return rows[0] if rows else {"datname": "postgres", "size_bytes": 0}

    def _create_result(
        self,
        check_id: str,
        check_title: str,
        data: Dict[str, Any],
        error: Optional[str] = None
    ) -> CheckResult:
        """Create a CheckResult with common fields."""
        return CheckResult(
            check_id=check_id,
            check_title=check_title,
            timestamp=datetime.utcnow().isoformat() + "Z",
            data=data,
            postgres_version=self._pg_version,
            error=error
        )

    # =========================================================================
    # Individual Check Methods
    # =========================================================================

    def check_h002_unused_indexes(self) -> CheckResult:
        """
        H002: Find unused indexes.

        Identifies indexes that have never been scanned since stats were reset.
        These are candidates for removal to save disk space and write overhead.
        """
        pg_ver = self.get_postgres_version()
        db_info = self.get_current_database()

        sql = """
        WITH fk_indexes AS (
            SELECT
                n.nspname AS schema_name,
                ci.relname AS index_name,
                cr.relname AS table_name,
                (confrelid::regclass)::text AS fk_table_ref,
                array_to_string(indclass, ', ') AS opclasses
            FROM pg_index i
            JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relkind = 'i'
            JOIN pg_class cr ON cr.oid = i.indrelid AND cr.relkind = 'r'
            JOIN pg_namespace n ON n.oid = ci.relnamespace
            JOIN pg_constraint cn ON cn.conrelid = cr.oid
            LEFT JOIN pg_stat_all_indexes AS si ON si.indexrelid = i.indexrelid
            WHERE
                contype = 'f'
                AND i.indisunique IS false
                AND conkey IS NOT NULL
                AND ci.relpages > 5
                AND si.idx_scan < 10
        ),
        table_scans AS (
            SELECT
                relid,
                tables.idx_scan + tables.seq_scan AS all_scans,
                (tables.n_tup_ins + tables.n_tup_upd + tables.n_tup_del) AS writes,
                pg_relation_size(relid) AS table_size
            FROM pg_stat_all_tables AS tables
            JOIN pg_class c ON c.oid = relid
            WHERE c.relpages > 5
        ),
        indexes AS (
            SELECT
                i.indrelid,
                i.indexrelid,
                n.nspname AS schema_name,
                cr.relname AS table_name,
                ci.relname AS index_name,
                si.idx_scan,
                pg_relation_size(i.indexrelid) AS index_bytes,
                ci.relpages,
                (CASE WHEN a.amname = 'btree' THEN true ELSE false END) AS idx_is_btree,
                array_to_string(i.indclass, ', ') AS opclasses
            FROM pg_index i
            JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relkind = 'i'
            JOIN pg_class cr ON cr.oid = i.indrelid AND cr.relkind = 'r'
            JOIN pg_namespace n ON n.oid = ci.relnamespace
            JOIN pg_am a ON ci.relam = a.oid
            LEFT JOIN pg_stat_all_indexes AS si ON si.indexrelid = i.indexrelid
            WHERE
                i.indisunique = false
                AND i.indisvalid = true
                AND ci.relpages > 5
        ),
        index_ratios AS (
            SELECT
                i.indexrelid AS index_id,
                i.schema_name,
                i.table_name,
                i.index_name,
                idx_scan,
                all_scans,
                ROUND((CASE WHEN all_scans = 0 THEN 0.0::numeric
                    ELSE idx_scan::numeric/all_scans * 100 END), 2) AS index_scan_pct,
                writes,
                ROUND((CASE WHEN writes = 0 THEN idx_scan::numeric
                    ELSE idx_scan::numeric/writes END), 2) AS scans_per_write,
                index_bytes AS index_size_bytes,
                table_size AS table_size_bytes,
                i.relpages,
                idx_is_btree,
                i.opclasses,
                (
                    SELECT count(1)
                    FROM fk_indexes fi
                    WHERE fi.fk_table_ref = i.table_name
                        AND fi.schema_name = i.schema_name
                        AND fi.opclasses LIKE (i.opclasses || '%')
                ) > 0 AS supports_fk
            FROM indexes i
            JOIN table_scans ts ON ts.relid = i.indrelid
        )
        SELECT
            'Never Used Indexes' AS reason,
            schema_name,
            table_name,
            index_name,
            pg_get_indexdef(index_id) AS index_definition,
            idx_scan,
            index_size_bytes,
            idx_is_btree,
            supports_fk
        FROM index_ratios
        WHERE idx_scan = 0
        ORDER BY index_size_bytes DESC
        """

        rows = self._execute(sql)

        # Get stats reset info
        stats_reset = self._execute("""
            SELECT
                EXTRACT(EPOCH FROM stats_reset) AS stats_reset_epoch,
                stats_reset::text AS stats_reset_time,
                EXTRACT(EPOCH FROM (now() - stats_reset)) / 86400 AS days_since_reset
            FROM pg_stat_database
            WHERE datname = current_database()
        """)
        stats_reset_info = stats_reset[0] if stats_reset else {}

        unused_indexes = []
        total_size = 0
        for row in rows:
            size_bytes = int(row.get('index_size_bytes', 0))
            total_size += size_bytes
            unused_indexes.append({
                "schema_name": row['schema_name'],
                "table_name": row['table_name'],
                "index_name": row['index_name'],
                "index_definition": row.get('index_definition', ''),
                "reason": row.get('reason', 'Never Used Indexes'),
                "idx_scan": int(row.get('idx_scan', 0)),
                "index_size_bytes": size_bytes,
                "idx_is_btree": bool(row.get('idx_is_btree', False)),
                "supports_fk": bool(row.get('supports_fk', False)),
                "index_size_pretty": format_bytes(size_bytes),
            })

        db_size = int(db_info.get('size_bytes', 0))
        data = {
            db_info['datname']: {
                "unused_indexes": unused_indexes,
                "total_count": len(unused_indexes),
                "total_size_bytes": total_size,
                "total_size_pretty": format_bytes(total_size),
                "database_size_bytes": db_size,
                "database_size_pretty": format_bytes(db_size),
                "stats_reset": {
                    "stats_reset_epoch": stats_reset_info.get('stats_reset_epoch'),
                    "stats_reset_time": stats_reset_info.get('stats_reset_time'),
                    "days_since_reset": int(stats_reset_info.get('days_since_reset', 0)) if stats_reset_info.get('days_since_reset') else None,
                    "postmaster_startup_epoch": None,
                    "postmaster_startup_time": None,
                }
            }
        }

        return self._create_result("H002", "Unused indexes", data)

    def check_h001_invalid_indexes(self) -> CheckResult:
        """
        H001: Find invalid indexes.

        Identifies indexes with indisvalid = false, typically from failed
        CREATE INDEX CONCURRENTLY operations.
        """
        pg_ver = self.get_postgres_version()
        db_info = self.get_current_database()

        sql = """
        WITH invalid AS (
            SELECT
                n.nspname AS schema_name,
                ct.relname AS table_name,
                ci.relname AS index_name,
                n.nspname || '.' || ci.relname AS relation_name,
                pg_relation_size(i.indexrelid) AS index_size_bytes,
                pg_get_indexdef(i.indexrelid) AS index_definition,
                i.indisprimary AS is_pk,
                i.indisunique AS is_unique,
                con.conname AS constraint_name,
                ct.reltuples::bigint AS table_row_estimate,
                EXISTS (
                    SELECT 1 FROM pg_index i2
                    JOIN pg_class ci2 ON ci2.oid = i2.indexrelid
                    WHERE i2.indrelid = i.indrelid
                    AND i2.indisvalid = true
                    AND pg_get_indexdef(i2.indexrelid) = pg_get_indexdef(i.indexrelid)
                ) AS has_valid_duplicate
            FROM pg_index i
            JOIN pg_class ci ON ci.oid = i.indexrelid
            JOIN pg_class ct ON ct.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = ci.relnamespace
            LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
            WHERE i.indisvalid = false
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        )
        SELECT * FROM invalid
        ORDER BY index_size_bytes DESC
        """

        rows = self._execute(sql)

        invalid_indexes = []
        total_size = 0
        for row in rows:
            size_bytes = int(row.get('index_size_bytes', 0))
            total_size += size_bytes
            invalid_indexes.append({
                "schema_name": row['schema_name'],
                "table_name": row['table_name'],
                "index_name": row['index_name'],
                "relation_name": row.get('relation_name', ''),
                "index_size_bytes": size_bytes,
                "index_size_pretty": format_bytes(size_bytes),
                "index_definition": row.get('index_definition', ''),
                "supports_fk": False,  # Invalid indexes can't support FKs
                "is_pk": bool(row.get('is_pk', False)),
                "is_unique": bool(row.get('is_unique', False)),
                "constraint_name": row.get('constraint_name'),
                "table_row_estimate": int(row.get('table_row_estimate', 0)),
                "has_valid_duplicate": bool(row.get('has_valid_duplicate', False)),
                "valid_duplicate_name": None,
                "valid_duplicate_definition": None,
            })

        db_size = int(db_info.get('size_bytes', 0))
        data = {
            db_info['datname']: {
                "invalid_indexes": invalid_indexes,
                "total_count": len(invalid_indexes),
                "total_size_bytes": total_size,
                "total_size_pretty": format_bytes(total_size),
                "database_size_bytes": db_size,
                "database_size_pretty": format_bytes(db_size),
            }
        }

        return self._create_result("H001", "Invalid indexes", data)

    def check_h004_redundant_indexes(self) -> CheckResult:
        """
        H004: Find redundant indexes.

        Identifies indexes that are fully covered by other indexes
        (same leading columns).
        """
        pg_ver = self.get_postgres_version()
        db_info = self.get_current_database()

        sql = """
        WITH index_data AS (
            SELECT
                n.nspname AS schema_name,
                ct.relname AS table_name,
                ci.relname AS index_name,
                n.nspname || '.' || ci.relname AS relation_name,
                am.amname AS access_method,
                pg_get_indexdef(i.indexrelid) AS index_definition,
                pg_relation_size(i.indexrelid) AS index_size_bytes,
                pg_relation_size(i.indrelid) AS table_size_bytes,
                COALESCE(s.idx_scan, 0) AS index_usage,
                i.indkey::text AS indkey_text,
                i.indrelid,
                i.indexrelid
            FROM pg_index i
            JOIN pg_class ci ON ci.oid = i.indexrelid
            JOIN pg_class ct ON ct.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = ci.relnamespace
            JOIN pg_am am ON am.oid = ci.relam
            LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
            WHERE i.indisvalid = true
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ),
        redundant AS (
            SELECT
                d1.*,
                d2.index_name AS redundant_to_name,
                d2.index_definition AS redundant_to_definition,
                d2.index_size_bytes AS redundant_to_size_bytes
            FROM index_data d1
            JOIN index_data d2 ON d1.indrelid = d2.indrelid
                AND d1.indexrelid != d2.indexrelid
                AND d1.indkey_text LIKE d2.indkey_text || '%'
                AND d1.indkey_text != d2.indkey_text
            WHERE d1.access_method = d2.access_method
        )
        SELECT DISTINCT ON (schema_name, table_name, index_name)
            schema_name,
            table_name,
            index_name,
            relation_name,
            access_method,
            'Redundant to: ' || redundant_to_name AS reason,
            index_size_bytes,
            table_size_bytes,
            index_usage,
            false AS supports_fk,
            index_definition,
            json_agg(json_build_object(
                'index_name', redundant_to_name,
                'index_definition', redundant_to_definition,
                'index_size_bytes', redundant_to_size_bytes
            )) AS redundant_to_json
        FROM redundant
        GROUP BY schema_name, table_name, index_name, relation_name,
                 access_method, index_size_bytes, table_size_bytes,
                 index_usage, index_definition, redundant_to_name
        ORDER BY schema_name, table_name, index_name, index_size_bytes DESC
        """

        rows = self._execute(sql)

        redundant_indexes = []
        total_size = 0
        for row in rows:
            size_bytes = int(row.get('index_size_bytes', 0))
            table_size = int(row.get('table_size_bytes', 0))
            total_size += size_bytes

            # Parse redundant_to JSON
            redundant_to = []
            if row.get('redundant_to_json'):
                try:
                    import json
                    rt_data = row['redundant_to_json']
                    if isinstance(rt_data, str):
                        rt_data = json.loads(rt_data)
                    for item in rt_data:
                        rt_size = int(item.get('index_size_bytes', 0))
                        redundant_to.append({
                            "index_name": item.get('index_name', ''),
                            "index_definition": item.get('index_definition', ''),
                            "index_size_bytes": rt_size,
                            "index_size_pretty": format_bytes(rt_size),
                        })
                except Exception:
                    pass

            redundant_indexes.append({
                "schema_name": row['schema_name'],
                "table_name": row['table_name'],
                "index_name": row['index_name'],
                "relation_name": row.get('relation_name', ''),
                "access_method": row.get('access_method', 'btree'),
                "reason": row.get('reason', ''),
                "index_size_bytes": size_bytes,
                "table_size_bytes": table_size,
                "index_usage": int(row.get('index_usage', 0)),
                "supports_fk": bool(row.get('supports_fk', False)),
                "index_definition": row.get('index_definition', ''),
                "index_size_pretty": format_bytes(size_bytes),
                "table_size_pretty": format_bytes(table_size),
                "redundant_to": redundant_to,
            })

        db_size = int(db_info.get('size_bytes', 0))
        data = {
            db_info['datname']: {
                "redundant_indexes": redundant_indexes,
                "total_count": len(redundant_indexes),
                "total_size_bytes": total_size,
                "total_size_pretty": format_bytes(total_size),
                "database_size_bytes": db_size,
                "database_size_pretty": format_bytes(db_size),
            }
        }

        return self._create_result("H004", "Redundant indexes", data)

    def check_a002_version(self) -> CheckResult:
        """A002: Get PostgreSQL major version."""
        pg_ver = self.get_postgres_version()
        return self._create_result("A002", "Postgres major version", {
            "version": {
                "version": pg_ver.version,
                "server_version_num": str(pg_ver.server_version_num),
                "server_major_ver": str(pg_ver.major),
                "server_minor_ver": str(pg_ver.minor),
            }
        })

    def check_f004_table_bloat(self) -> CheckResult:
        """
        F004: Estimate table bloat.

        Uses statistical analysis to estimate dead tuple bloat in tables.
        """
        pg_ver = self.get_postgres_version()
        db_info = self.get_current_database()

        sql = """
        SELECT
            schemaname AS schema_name,
            relname AS table_name,
            pg_relation_size(relid) AS real_size,
            COALESCE(n_dead_tup, 0) AS dead_tuples,
            COALESCE(n_live_tup, 0) AS live_tuples,
            CASE WHEN n_live_tup > 0
                THEN ROUND(100.0 * n_dead_tup / n_live_tup, 2)
                ELSE 0
            END AS bloat_pct,
            last_vacuum,
            last_autovacuum
        FROM pg_stat_user_tables
        WHERE pg_relation_size(relid) > 1024 * 1024  -- > 1MB
        ORDER BY n_dead_tup DESC
        LIMIT 100
        """

        rows = self._execute(sql)

        bloated_tables = []
        total_bloat = 0
        for row in rows:
            real_size = int(row.get('real_size', 0))
            bloat_pct = float(row.get('bloat_pct', 0))
            estimated_bloat = int(real_size * bloat_pct / 100)
            total_bloat += estimated_bloat

            last_vacuum = row.get('last_vacuum') or row.get('last_autovacuum')

            bloated_tables.append({
                "schema_name": row['schema_name'],
                "table_name": row['table_name'],
                "real_size": real_size,
                "real_size_pretty": format_bytes(real_size),
                "bloat_pct": bloat_pct,
                "bloat_size": estimated_bloat,
                "bloat_size_pretty": format_bytes(estimated_bloat),
                "dead_tuples": int(row.get('dead_tuples', 0)),
                "live_tuples": int(row.get('live_tuples', 0)),
                "last_vacuum": str(last_vacuum) if last_vacuum else None,
                "fillfactor": 100,
            })

        db_size = int(db_info.get('size_bytes', 0))
        data = {
            db_info['datname']: {
                "bloated_tables": bloated_tables,
                "total_count": len(bloated_tables),
                "total_bloat_size_bytes": total_bloat,
                "total_bloat_size_pretty": format_bytes(total_bloat),
                "database_size_bytes": db_size,
                "database_size_pretty": format_bytes(db_size),
            }
        }

        return self._create_result("F004", "Autovacuum: heap bloat (estimated)", data)

    # =========================================================================
    # Run All Checks
    # =========================================================================

    def run_all(
        self,
        on_progress: Optional[Callable[[str, str, int, int], None]] = None
    ) -> Dict[str, CheckResult]:
        """
        Run all available health checks.

        Args:
            on_progress: Optional callback(check_id, check_title, index, total)

        Returns:
            Dictionary mapping check IDs to CheckResults
        """
        from .checks import AVAILABLE_CHECKS

        results = {}
        total = len(AVAILABLE_CHECKS)

        for i, (check_id, check_info) in enumerate(AVAILABLE_CHECKS.items(), 1):
            if on_progress:
                on_progress(check_id, check_info['title'], i, total)

            method = getattr(self, check_info['method'], None)
            if method:
                try:
                    results[check_id] = method()
                except Exception as e:
                    results[check_id] = self._create_result(
                        check_id, check_info['title'], {}, error=str(e)
                    )

        return results

    def run_check(self, check_id: str) -> CheckResult:
        """Run a specific check by ID."""
        from .checks import AVAILABLE_CHECKS

        check_info = AVAILABLE_CHECKS.get(check_id)
        if not check_info:
            raise ValueError(f"Unknown check ID: {check_id}")

        method = getattr(self, check_info['method'], None)
        if not method:
            raise ValueError(f"Check method not implemented: {check_info['method']}")

        return method()

    def close(self):
        """Close the database connection if we own it."""
        if self._owns_connection and self._conn:
            self._conn.close()
            self._conn = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False
