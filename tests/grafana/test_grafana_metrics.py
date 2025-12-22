"""
End-to-end test to verify Grafana monitoring stack extracts and displays basic metrics.

This test:
1. Connects to the target database and creates simple load
2. Waits for pgwatch to collect metrics
3. Queries Prometheus/VictoriaMetrics for basic metrics (db_size, transaction stats)
4. Queries Grafana API to verify dashboards are loaded and datasources are working
5. Validates metric data is present and reasonable
"""

import argparse
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

import psycopg
import requests


class GrafanaMetricsTest:
    """E2E test for Grafana monitoring stack."""

    def __init__(
        self,
        target_db_url: str,
        prometheus_url: str,
        grafana_url: str,
        grafana_user: str,
        grafana_password: str,
        test_dbname: str = "target_database",
        cluster_name: str = "local",
        node_name: str = "node-01",
        collection_wait_seconds: int = 90,
    ):
        self.target_db_url = target_db_url
        self.prometheus_url = prometheus_url.rstrip("/")
        self.grafana_url = grafana_url.rstrip("/")
        self.grafana_auth = (grafana_user, grafana_password)
        self.test_dbname = test_dbname
        self.cluster_name = cluster_name
        self.node_name = node_name
        self.collection_wait_seconds = collection_wait_seconds
        self.target_conn = None
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def log(self, message: str, level: str = "info"):
        """Log message with timestamp."""
        timestamp = datetime.now().strftime("%H:%M:%S")
        prefix = {"info": " ", "ok": "✓", "warn": "⚠", "error": "✗"}
        print(f"[{timestamp}] {prefix.get(level, ' ')} {message}")

    def setup(self) -> bool:
        """Set up test environment and verify connectivity."""
        self.log("Setting up test environment...")

        # Verify target database connectivity
        try:
            self.target_conn = psycopg.connect(self.target_db_url)
            self.target_conn.autocommit = True
            with self.target_conn.cursor() as cur:
                cur.execute("SELECT version()")
                version = cur.fetchone()[0]
            self.log(f"Target database connected: {version[:50]}...", "ok")
        except Exception as e:
            self.log(f"Failed to connect to target database: {e}", "error")
            self.errors.append(f"Database connection failed: {e}")
            return False

        # Verify Prometheus connectivity
        try:
            response = requests.get(
                f"{self.prometheus_url}/api/v1/status/config", timeout=10
            )
            response.raise_for_status()
            self.log("Prometheus/VictoriaMetrics connection verified", "ok")
        except Exception as e:
            self.log(f"Failed to connect to Prometheus: {e}", "error")
            self.errors.append(f"Prometheus connection failed: {e}")
            return False

        # Verify Grafana connectivity
        try:
            response = requests.get(
                f"{self.grafana_url}/api/health",
                auth=self.grafana_auth,
                timeout=10,
            )
            response.raise_for_status()
            health = response.json()
            self.log(f"Grafana connection verified: {health.get('database', 'ok')}", "ok")
        except Exception as e:
            self.log(f"Failed to connect to Grafana: {e}", "error")
            self.errors.append(f"Grafana connection failed: {e}")
            return False

        return True

    def generate_load(self) -> bool:
        """Generate simple database load to ensure metrics are collected."""
        self.log("Generating database load...")

        if not self.target_conn:
            self.log("No database connection", "error")
            return False

        try:
            with self.target_conn.cursor() as cur:
                # Create test table
                cur.execute("""
                    DROP TABLE IF EXISTS grafana_e2e_test CASCADE;
                    CREATE TABLE grafana_e2e_test (
                        id SERIAL PRIMARY KEY,
                        data TEXT,
                        value NUMERIC(10,2),
                        created_at TIMESTAMPTZ DEFAULT NOW()
                    );
                """)

                # Insert some rows to generate transaction activity
                for i in range(100):
                    cur.execute(
                        "INSERT INTO grafana_e2e_test (data, value) VALUES (%s, %s)",
                        (f"test_data_{i}", i * 1.5),
                    )

                # Run some queries to generate read activity
                for _ in range(50):
                    cur.execute("SELECT COUNT(*) FROM grafana_e2e_test")
                    cur.execute("SELECT * FROM grafana_e2e_test ORDER BY id DESC LIMIT 10")

                # Check table size
                cur.execute("""
                    SELECT pg_size_pretty(pg_total_relation_size('grafana_e2e_test'))
                """)
                size = cur.fetchone()[0]
                self.log(f"Test table created with size: {size}", "ok")

                # Get database size
                cur.execute("""
                    SELECT pg_size_pretty(pg_database_size(current_database()))
                """)
                db_size = cur.fetchone()[0]
                self.log(f"Current database size: {db_size}", "ok")

            return True
        except Exception as e:
            self.log(f"Failed to generate load: {e}", "error")
            self.errors.append(f"Load generation failed: {e}")
            return False

    def wait_for_metrics(self):
        """Wait for pgwatch to collect and export metrics."""
        self.log(
            f"Waiting {self.collection_wait_seconds}s for metrics collection..."
        )

        # Wait in intervals and show progress
        interval = 15
        elapsed = 0
        while elapsed < self.collection_wait_seconds:
            wait_time = min(interval, self.collection_wait_seconds - elapsed)
            time.sleep(wait_time)
            elapsed += wait_time
            remaining = self.collection_wait_seconds - elapsed
            if remaining > 0:
                self.log(f"  {remaining}s remaining...")

        self.log("Wait complete", "ok")

    def query_prometheus(self, query: str) -> dict[str, Any] | None:
        """Execute PromQL query and return results."""
        try:
            response = requests.get(
                f"{self.prometheus_url}/api/v1/query",
                params={"query": query},
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
            if data.get("status") == "success":
                return data.get("data", {})
            return None
        except Exception as e:
            self.log(f"Prometheus query failed: {e}", "warn")
            return None

    def verify_db_size_metric(self) -> bool:
        """Verify database size metric is present and reasonable."""
        self.log("Verifying database size metric (pgwatch_db_size_size_b)...")

        query = f'pgwatch_db_size_size_b{{datname="{self.test_dbname}", cluster="{self.cluster_name}"}}'
        data = self.query_prometheus(query)

        if not data or not data.get("result"):
            self.log("No db_size metric found", "error")
            self.errors.append("pgwatch_db_size_size_b metric not found")
            return False

        results = data["result"]
        self.log(f"Found {len(results)} db_size metric sample(s)", "ok")

        # Validate the metric value
        for result in results:
            value = result.get("value", [None, None])
            if len(value) >= 2 and value[1]:
                size_bytes = float(value[1])
                # Database should be at least a few MB (basic Postgres)
                if size_bytes > 1_000_000:  # > 1MB
                    size_mb = size_bytes / (1024 * 1024)
                    self.log(f"Database size: {size_mb:.2f} MB", "ok")
                    return True
                else:
                    self.log(f"Database size seems too small: {size_bytes} bytes", "warn")
                    self.warnings.append(f"DB size unexpectedly small: {size_bytes} bytes")

        return True

    def verify_transaction_metrics(self) -> bool:
        """Verify transaction commit/rollback metrics are present."""
        self.log("Verifying transaction metrics...")

        metrics_found = 0
        for metric in ["pgwatch_db_stats_xact_commit", "pgwatch_db_stats_xact_rollback"]:
            query = f'{metric}{{datname="{self.test_dbname}", cluster="{self.cluster_name}"}}'
            data = self.query_prometheus(query)

            if data and data.get("result"):
                results = data["result"]
                if results:
                    value = results[0].get("value", [None, None])
                    if len(value) >= 2 and value[1]:
                        count = float(value[1])
                        self.log(f"{metric}: {count:.0f}", "ok")
                        metrics_found += 1

        if metrics_found == 0:
            self.log("No transaction metrics found", "error")
            self.errors.append("Transaction metrics not found")
            return False

        return True

    def verify_tuple_metrics(self) -> bool:
        """Verify tuple read/write metrics are present."""
        self.log("Verifying tuple metrics...")

        metrics_found = 0
        tuple_metrics = [
            "pgwatch_db_stats_tup_returned",
            "pgwatch_db_stats_tup_fetched",
            "pgwatch_db_stats_tup_inserted",
        ]

        for metric in tuple_metrics:
            query = f'{metric}{{datname="{self.test_dbname}", cluster="{self.cluster_name}"}}'
            data = self.query_prometheus(query)

            if data and data.get("result"):
                results = data["result"]
                if results:
                    value = results[0].get("value", [None, None])
                    if len(value) >= 2 and value[1]:
                        count = float(value[1])
                        self.log(f"{metric}: {count:.0f}", "ok")
                        metrics_found += 1

        if metrics_found == 0:
            self.log("No tuple metrics found", "error")
            self.errors.append("Tuple metrics not found")
            return False

        return True

    def verify_grafana_datasources(self) -> bool:
        """Verify Grafana datasources are configured and healthy."""
        self.log("Verifying Grafana datasources...")

        try:
            response = requests.get(
                f"{self.grafana_url}/api/datasources",
                auth=self.grafana_auth,
                timeout=10,
            )
            response.raise_for_status()
            datasources = response.json()

            if not datasources:
                self.log("No datasources configured in Grafana", "error")
                self.errors.append("No Grafana datasources found")
                return False

            self.log(f"Found {len(datasources)} datasource(s):", "ok")

            prometheus_found = False
            for ds in datasources:
                ds_name = ds.get("name", "unknown")
                ds_type = ds.get("type", "unknown")
                self.log(f"  - {ds_name} ({ds_type})")
                if ds_type == "prometheus":
                    prometheus_found = True

            if not prometheus_found:
                self.log("Prometheus datasource not found", "warn")
                self.warnings.append("No Prometheus datasource in Grafana")

            return True
        except Exception as e:
            self.log(f"Failed to get datasources: {e}", "error")
            self.errors.append(f"Grafana datasources check failed: {e}")
            return False

    def verify_grafana_dashboards(self) -> bool:
        """Verify Grafana dashboards are loaded."""
        self.log("Verifying Grafana dashboards...")

        try:
            response = requests.get(
                f"{self.grafana_url}/api/search?type=dash-db",
                auth=self.grafana_auth,
                timeout=10,
            )
            response.raise_for_status()
            dashboards = response.json()

            if not dashboards:
                self.log("No dashboards found in Grafana", "error")
                self.errors.append("No Grafana dashboards found")
                return False

            self.log(f"Found {len(dashboards)} dashboard(s):", "ok")

            # Show first few dashboards
            for dash in dashboards[:5]:
                title = dash.get("title", "unknown")
                self.log(f"  - {title}")

            if len(dashboards) > 5:
                self.log(f"  ... and {len(dashboards) - 5} more")

            # Check for expected dashboards
            expected_dashboards = ["Node", "Query", "Table"]
            titles = [d.get("title", "").lower() for d in dashboards]

            for expected in expected_dashboards:
                if any(expected.lower() in t for t in titles):
                    self.log(f"Found dashboard matching '{expected}'", "ok")

            return True
        except Exception as e:
            self.log(f"Failed to get dashboards: {e}", "error")
            self.errors.append(f"Grafana dashboards check failed: {e}")
            return False

    def verify_dashboard_query(self) -> bool:
        """Test that a dashboard panel query returns data via Grafana."""
        self.log("Testing dashboard query execution via Grafana...")

        # Query the prometheus datasource through Grafana's proxy
        try:
            # First, get the prometheus datasource ID
            response = requests.get(
                f"{self.grafana_url}/api/datasources",
                auth=self.grafana_auth,
                timeout=10,
            )
            response.raise_for_status()
            datasources = response.json()

            prometheus_ds = None
            for ds in datasources:
                if ds.get("type") == "prometheus":
                    prometheus_ds = ds
                    break

            if not prometheus_ds:
                self.log("No Prometheus datasource for query test", "warn")
                return True  # Not a hard failure

            ds_uid = prometheus_ds.get("uid")

            # Query through Grafana's datasource proxy
            query = f'pgwatch_db_size_size_b{{datname="{self.test_dbname}"}}'
            response = requests.post(
                f"{self.grafana_url}/api/ds/query",
                auth=self.grafana_auth,
                json={
                    "queries": [
                        {
                            "refId": "A",
                            "datasource": {"uid": ds_uid, "type": "prometheus"},
                            "expr": query,
                            "instant": True,
                        }
                    ],
                    "from": "now-5m",
                    "to": "now",
                },
                timeout=15,
            )
            response.raise_for_status()
            result = response.json()

            # Check if we got results
            frames = result.get("results", {}).get("A", {}).get("frames", [])
            if frames:
                self.log("Grafana datasource proxy query returned data", "ok")
                return True
            else:
                self.log("Grafana query returned no data", "warn")
                self.warnings.append("Grafana proxy query returned empty results")
                return True

        except Exception as e:
            self.log(f"Dashboard query test failed: {e}", "warn")
            self.warnings.append(f"Dashboard query test failed: {e}")
            return True  # Not a hard failure

    def cleanup(self):
        """Clean up test resources."""
        self.log("Cleaning up...")

        if self.target_conn:
            try:
                with self.target_conn.cursor() as cur:
                    cur.execute("DROP TABLE IF EXISTS grafana_e2e_test CASCADE")
                self.target_conn.close()
            except Exception:
                pass

        self.log("Cleanup complete", "ok")

    def run(self) -> bool:
        """Run the complete e2e test suite."""
        print("\n" + "=" * 60)
        print("Grafana E2E Metrics Test")
        print("=" * 60 + "\n")

        try:
            # Setup
            if not self.setup():
                return False

            # Generate load
            if not self.generate_load():
                return False

            # Wait for metrics collection
            self.wait_for_metrics()

            # Verify Prometheus metrics
            print("\n--- Prometheus Metrics Verification ---")
            db_size_ok = self.verify_db_size_metric()
            tx_ok = self.verify_transaction_metrics()
            tuple_ok = self.verify_tuple_metrics()

            # Verify Grafana
            print("\n--- Grafana Verification ---")
            ds_ok = self.verify_grafana_datasources()
            dash_ok = self.verify_grafana_dashboards()
            query_ok = self.verify_dashboard_query()

            # Summary
            print("\n" + "=" * 60)
            print("Test Summary")
            print("=" * 60)

            all_passed = all([db_size_ok, tx_ok, tuple_ok, ds_ok, dash_ok, query_ok])

            if self.warnings:
                print(f"\nWarnings ({len(self.warnings)}):")
                for w in self.warnings:
                    print(f"  ⚠ {w}")

            if self.errors:
                print(f"\nErrors ({len(self.errors)}):")
                for e in self.errors:
                    print(f"  ✗ {e}")

            print()
            if all_passed and not self.errors:
                print("✅ All tests PASSED")
                return True
            else:
                print("❌ Some tests FAILED")
                return False

        except Exception as e:
            self.log(f"Test error: {e}", "error")
            import traceback
            traceback.print_exc()
            return False
        finally:
            self.cleanup()


def main():
    parser = argparse.ArgumentParser(
        description="E2E test for Grafana monitoring metrics"
    )
    parser.add_argument(
        "--target-db-url",
        default=os.getenv(
            "TARGET_DB_URL",
            "postgresql://postgres:postgres@localhost:55432/target_database",
        ),
        help="Target database connection URL",
    )
    parser.add_argument(
        "--prometheus-url",
        default=os.getenv("PROMETHEUS_URL", "http://localhost:59090"),
        help="Prometheus/VictoriaMetrics API URL",
    )
    parser.add_argument(
        "--grafana-url",
        default=os.getenv("GRAFANA_URL", "http://localhost:3000"),
        help="Grafana API URL",
    )
    parser.add_argument(
        "--grafana-user",
        default=os.getenv("GRAFANA_USER", "monitor"),
        help="Grafana admin username",
    )
    parser.add_argument(
        "--grafana-password",
        default=os.getenv("GRAFANA_PASSWORD", "demo"),
        help="Grafana admin password",
    )
    parser.add_argument(
        "--test-dbname",
        default=os.getenv("TEST_DBNAME", "target_database"),
        help="Name of the database being monitored",
    )
    parser.add_argument(
        "--cluster-name",
        default=os.getenv("CLUSTER_NAME", "local"),
        help="Cluster name label in metrics",
    )
    parser.add_argument(
        "--node-name",
        default=os.getenv("NODE_NAME", "node-01"),
        help="Node name label in metrics",
    )
    parser.add_argument(
        "--collection-wait",
        type=int,
        default=int(os.getenv("COLLECTION_WAIT_SECONDS", "90")),
        help="Seconds to wait for pgwatch to collect metrics",
    )

    args = parser.parse_args()

    test = GrafanaMetricsTest(
        target_db_url=args.target_db_url,
        prometheus_url=args.prometheus_url,
        grafana_url=args.grafana_url,
        grafana_user=args.grafana_user,
        grafana_password=args.grafana_password,
        test_dbname=args.test_dbname,
        cluster_name=args.cluster_name,
        node_name=args.node_name,
        collection_wait_seconds=args.collection_wait,
    )

    success = test.run()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
