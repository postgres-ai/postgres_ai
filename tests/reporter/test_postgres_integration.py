import json
from datetime import datetime, timezone
from typing import Callable, Tuple

import pytest

from reporter.postgres_reports import PostgresReportGenerator

Seeder = Callable[[str, str, str], None]


@pytest.fixture(scope="function")
def sink_index_data(postgresql) -> Tuple[str, Seeder]:
    conn = postgresql
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(
        """
        create table if not exists public.index_definitions (
            time timestamptz not null,
            dbname text not null,
            data jsonb not null,
            tag_data jsonb
        )
        """
    )

    def seed(dbname: str, index_name: str, index_def: str) -> None:
        payload = {
            "indexrelname": index_name,
            "index_definition": index_def,
            "schemaname": "public",
            "relname": "tbl",
        }
        with conn.cursor() as seed_cur:
            seed_cur.execute(
                (
                    "insert into public.index_definitions "
                    "(time, dbname, data) values (%s, %s, %s::jsonb)"
                ),
                (datetime.now(timezone.utc), dbname, json.dumps(payload)),
            )

    host = conn.info.host or conn.info.hostaddr or "localhost"
    port = conn.info.port
    user = conn.info.user
    dbname = conn.info.dbname
    dsn = f"postgresql://{user}@{host}:{port}/{dbname}"

    yield dsn, seed

    cur.execute("truncate table public.index_definitions")
    cur.close()


@pytest.mark.integration
@pytest.mark.requires_postgres
def test_get_index_definitions_from_sink(sink_index_data) -> None:
    dsn, seed = sink_index_data
    seed("db1", "idx_users", "CREATE INDEX idx_users ON users(id)")
    seed("db2", "idx_orders", "CREATE INDEX idx_orders ON orders(id)")

    generator = PostgresReportGenerator(
        prometheus_url="http://unused",
        postgres_sink_url=dsn,
    )
    assert generator.connect_postgres_sink()

    definitions = generator.get_index_definitions_from_sink()

    assert definitions["db1.idx_users"] == "CREATE INDEX idx_users ON users(id)"
    assert definitions["db2.idx_orders"] == "CREATE INDEX idx_orders ON orders(id)"

    generator.close_postgres_sink()
    assert generator.pg_conn is None
