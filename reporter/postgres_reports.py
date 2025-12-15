#!/usr/bin/env python3
"""
PostgreSQL Reports Generator using PromQL

This script generates reports for specific PostgreSQL check types (A002, A003, A004, A007, D004, F001, F004, F005, H001, H002, H004, K001, K003, M001, M002, M003, N001)
by querying Prometheus metrics using PromQL queries.
"""

__version__ = "1.0.2"

import requests
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Any, Optional
import argparse
import sys
import os
import psycopg2
import psycopg2.extras


class PostgresReportGenerator:
    # Default databases to always exclude
    DEFAULT_EXCLUDED_DATABASES = {'template0', 'template1', 'rdsadmin', 'azure_maintenance', 'cloudsqladmin'}
    
    def __init__(self, prometheus_url: str = "http://sink-prometheus:9090", 
                 postgres_sink_url: str = "postgresql://pgwatch@sink-postgres:5432/measurements",
                 excluded_databases: Optional[List[str]] = None):
        """
        Initialize the PostgreSQL report generator.
        
        Args:
            prometheus_url: URL of the Prometheus instance (default: http://sink-prometheus:9090)
            postgres_sink_url: Connection string for the Postgres sink database 
                              (default: postgresql://pgwatch@sink-postgres:5432/measurements)
            excluded_databases: Additional databases to exclude from reports
        """
        self.prometheus_url = prometheus_url
        self.base_url = f"{prometheus_url}/api/v1"
        self.postgres_sink_url = postgres_sink_url
        self.pg_conn = None
        # Combine default exclusions with user-provided exclusions
        self.excluded_databases = self.DEFAULT_EXCLUDED_DATABASES.copy()
        if excluded_databases:
            self.excluded_databases.update(excluded_databases)

    def test_connection(self) -> bool:
        """Test connection to Prometheus."""
        try:
            response = requests.get(f"{self.base_url}/status/config", timeout=10)
            return response.status_code == 200
        except Exception as e:
            print(f"Connection failed: {e}")
            return False

    def connect_postgres_sink(self) -> bool:
        """Connect to Postgres sink database."""
        if not self.postgres_sink_url:
            return False
        
        try:
            self.pg_conn = psycopg2.connect(self.postgres_sink_url)
            return True
        except Exception as e:
            print(f"Postgres sink connection failed: {e}")
            return False

    def close_postgres_sink(self):
        """Close Postgres sink connection."""
        if self.pg_conn:
            self.pg_conn.close()
            self.pg_conn = None

    def get_index_definitions_from_sink(self, db_name: str = None) -> Dict[str, str]:
        """
        Get index definitions from the Postgres sink database.
        
        Args:
            db_name: Optional database name to filter results
        
        Returns:
            Dictionary mapping index names to their definitions
        """
        if not self.pg_conn:
            if not self.connect_postgres_sink():
                return {}
        
        index_definitions = {}
        
        try:
            with self.pg_conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cursor:
                # Query the index_definitions table for the most recent data
                # 
                # PERFORMANCE NOTE: This query will use a Seq Scan on index_definitions table.
                # This is acceptable because:
                # 1. This method is called VERY rarely (only during report generation)
                # 2. The table size is expected to remain small (< 10000 rows per database)
                # 3. Current latency is well under 1 second for typical workloads
                # 
                # If the table grows significantly larger (>> 10000 rows) or latency exceeds 1s,
                # consider adding a GIN index on the data JSONB column or materialized view.
                if db_name:
                    query = """
                        select distinct on (data->>'indexrelname')
                            data->>'indexrelname' as indexrelname,
                            data->>'index_definition' as index_definition,
                            dbname
                        from public.index_definitions
                        order by data->>'indexrelname', time desc
                    """
                    cursor.execute(query, (db_name,))
                else:
                    query = """
                        select distinct on (dbname, data->>'indexrelname')
                            data->>'indexrelname' as indexrelname,
                            data->>'index_definition' as index_definition,
                            dbname
                        from public.index_definitions
                        order by dbname, data->>'indexrelname', time desc
                    """
                    cursor.execute(query)
                
                for row in cursor.fetchall():
                    if row['indexrelname']:
                        # Include database name in the key to avoid collisions across databases
                        key = f"{row['dbname']}.{row['indexrelname']}" if not db_name else row['indexrelname']
                        index_definitions[key] = row['index_definition']
        
        except Exception as e:
            print(f"Error fetching index definitions from Postgres sink: {e}")
        
        return index_definitions

    def query_instant(self, query: str) -> Dict[str, Any]:
        """
        Execute an instant PromQL query.
        
        Args:
            query: PromQL query string
            
        Returns:
            Dictionary containing the query results
        """
        params = {'query': query}

        try:
            response = requests.get(f"{self.base_url}/query", params=params)
            if response.status_code == 200:
                return response.json()
            else:
                print(f"Query failed with status {response.status_code}: {response.text}")
                return {}
        except Exception as e:
            print(f"Query error: {e}")
            return {}

    def _get_postgres_version_info(self, cluster: str, node_name: str) -> Dict[str, str]:
        """
        Fetch and parse Postgres version information from pgwatch settings metrics.

        Notes:
        - This helper is intentionally defensive: it validates the returned setting_name label
          (tests may stub query responses broadly by metric name substring).
        - Uses a single query with a regex on setting_name to reduce roundtrips.
        """
        query = (
            f'last_over_time(pgwatch_settings_configured{{'
            f'cluster="{cluster}", node_name="{node_name}", '
            f'setting_name=~"server_version|server_version_num"}}[3h])'
        )

        result = self.query_instant(query)
        version_str = None
        version_num = None

        if result.get("status") == "success":
            if result.get("data", {}).get("result"):
                for item in result["data"]["result"]:
                    metric = item.get("metric", {}) or {}
                    setting_name = metric.get("setting_name", "")
                    setting_value = metric.get("setting_value", "")
                    if setting_name == "server_version" and setting_value:
                        version_str = setting_value
                    elif setting_name == "server_version_num" and setting_value:
                        version_num = setting_value
            else:
                print(f"Warning: No version data found (cluster={cluster}, node_name={node_name})")
        else:
            print(f"Warning: Version query failed (cluster={cluster}, node_name={node_name}): status={result.get('status')}")

        server_version = version_str or "Unknown"
        version_info: Dict[str, str] = {
            "version": server_version,
            "server_version_num": version_num or "Unknown",
            "server_major_ver": "Unknown",
            "server_minor_ver": "Unknown",
        }

        if server_version != "Unknown":
            # Handle both formats:
            # - "15.3"
            # - "15.3 (Ubuntu 15.3-1.pgdg20.04+1)"
            version_parts = server_version.split()[0].split(".")
            if len(version_parts) >= 1 and version_parts[0]:
                version_info["server_major_ver"] = version_parts[0]
                if len(version_parts) >= 2:
                    version_info["server_minor_ver"] = ".".join(version_parts[1:])
                else:
                    version_info["server_minor_ver"] = "0"

        return version_info

    def generate_a002_version_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
        """
        Generate A002 Version Information report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing version information
        """
        print(f"Generating A002 Version Information report for cluster='{cluster}', node_name='{node_name}'...")
        version_info = self._get_postgres_version_info(cluster, node_name)
        return self.format_report_data("A002", {"version": version_info}, node_name)

    def generate_a003_settings_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
        """
        Generate A003 PostgreSQL Settings report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing settings information
        """
        print("Generating A003 PostgreSQL Settings report...")

        # Query all PostgreSQL settings using the pgwatch_settings_configured metric with last_over_time
        # This metric has labels for each setting name
        settings_query = f'last_over_time(pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        result = self.query_instant(settings_query)

        settings_data = {}
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                # Extract setting name from labels
                setting_name = item['metric'].get('setting_name', '')
                setting_value = item['metric'].get('setting_value', '')
                
                # Skip if we don't have a setting name
                if not setting_name:
                    continue

                # Get additional metadata from labels
                category = item['metric'].get('category', 'Other')
                unit = item['metric'].get('unit', '')
                context = item['metric'].get('context', '')
                vartype = item['metric'].get('vartype', '')

                settings_data[setting_name] = {
                    "setting": setting_value,
                    "unit": unit,
                    "category": category,
                    "context": context,
                    "vartype": vartype,
                    "pretty_value": self.format_setting_value(setting_name, setting_value, unit)
                }
        else:
            print(f"Warning: A003 - No settings data returned for cluster={cluster}, node_name={node_name}")
            print(f"Query result status: {result.get('status')}")
            print(f"Query result data: {result.get('data', {})}")

        return self.format_report_data("A003", settings_data, node_name, postgres_version=self._get_postgres_version_info(cluster, node_name))

    def generate_a004_cluster_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
        """
        Generate A004 Cluster Information report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing cluster information
        """
        print("Generating A004 Cluster Information report...")

        # Query cluster information
        cluster_queries = {
            'active_connections': f'sum(last_over_time(pgwatch_pg_stat_activity_count{{cluster="{cluster}", node_name="{node_name}", state="active"}}[3h]))',
            'idle_connections': f'sum(last_over_time(pgwatch_pg_stat_activity_count{{cluster="{cluster}", node_name="{node_name}", state="idle"}}[3h]))',
            'total_connections': f'sum(last_over_time(pgwatch_pg_stat_activity_count{{cluster="{cluster}", node_name="{node_name}"}}[3h]))',
            'database_sizes': f'sum(last_over_time(pgwatch_db_size_size_b{{cluster="{cluster}", node_name="{node_name}"}}[3h]))',
            'cache_hit_ratio': f'sum(last_over_time(pgwatch_db_stats_blks_hit{{cluster="{cluster}", node_name="{node_name}"}}[3h])) / clamp_min(sum(last_over_time(pgwatch_db_stats_blks_hit{{cluster="{cluster}", node_name="{node_name}"}}[3h])) + sum(last_over_time(pgwatch_db_stats_blks_read{{cluster="{cluster}", node_name="{node_name}"}}[3h])), 1) * 100',
            'transactions_per_sec': f'sum(rate(pgwatch_db_stats_xact_commit{{cluster="{cluster}", node_name="{node_name}"}}[5m])) + sum(rate(pgwatch_db_stats_xact_rollback{{cluster="{cluster}", node_name="{node_name}"}}[5m]))',
            'checkpoints_per_sec': f'sum(rate(pgwatch_pg_stat_bgwriter_checkpoints_timed{{cluster="{cluster}", node_name="{node_name}"}}[5m])) + sum(rate(pgwatch_pg_stat_bgwriter_checkpoints_req{{cluster="{cluster}", node_name="{node_name}"}}[5m]))',
            'deadlocks': f'sum(last_over_time(pgwatch_db_stats_deadlocks{{cluster="{cluster}", node_name="{node_name}"}}[3h]))',
            'temp_files': f'sum(last_over_time(pgwatch_db_stats_temp_files{{cluster="{cluster}", node_name="{node_name}"}}[3h]))',
            'temp_bytes': f'sum(last_over_time(pgwatch_db_stats_temp_bytes{{cluster="{cluster}", node_name="{node_name}"}}[3h]))',
        }

        cluster_data = {}
        for metric_name, query in cluster_queries.items():
            result = self.query_instant(query)
            if result.get('status') == 'success' and result.get('data', {}).get('result'):
                values = result['data']['result']
                if values:
                    latest_value = values[0].get('value', [None, None])[1]
                    cluster_data[metric_name] = {
                        "value": latest_value,
                        "unit": self.get_cluster_metric_unit(metric_name),
                        "description": self.get_cluster_metric_description(metric_name)
                    }

        # Get database sizes
        db_sizes_query = f'last_over_time(pgwatch_db_size_size_b{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        db_sizes_result = self.query_instant(db_sizes_query)
        database_sizes = {}

        if db_sizes_result.get('status') == 'success' and db_sizes_result.get('data', {}).get('result'):
            for result in db_sizes_result['data']['result']:
                db_name = result['metric'].get('datname', 'unknown')
                size_bytes = float(result['value'][1])
                database_sizes[db_name] = size_bytes

        return self.format_report_data(
            "A004",
            {
                "general_info": cluster_data,
                "database_sizes": database_sizes,
            },
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_a007_altered_settings_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[
        str, Any]:
        """
        Generate A007 Altered Settings report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing altered settings information
        """
        print("Generating A007 Altered Settings report...")

        # Query settings by source using the pgwatch_settings_is_default metric with last_over_time
        # This returns settings where is_default = 0 (i.e., non-default/altered settings)
        settings_by_source_query = f'last_over_time(pgwatch_settings_is_default{{cluster="{cluster}", node_name="{node_name}"}}[3h]) < 1'
        result = self.query_instant(settings_by_source_query)

        altered_settings = {}
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                # Extract setting information from labels
                setting_name = item['metric'].get('setting_name', '')
                value = item['metric'].get('setting_value', '')
                unit = item['metric'].get('unit', '')
                category = item['metric'].get('category', 'Other')
                
                # Skip if we don't have a setting name
                if not setting_name:
                    continue
                
                pretty_value = self.format_setting_value(setting_name, value, unit)
                altered_settings[setting_name] = {
                    "value": value,
                    "unit": unit,
                    "category": category,
                    "pretty_value": pretty_value
                }
        else:
            print(f"Warning: A007 - No altered settings data returned for cluster={cluster}, node_name={node_name}")
            print(f"Query result status: {result.get('status')}")

        return self.format_report_data("A007", altered_settings, node_name, postgres_version=self._get_postgres_version_info(cluster, node_name))

    def generate_h001_invalid_indexes_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[
        str, Any]:
        """
        Generate H001 Invalid Indexes report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing invalid indexes information
        """
        print("Generating H001 Invalid Indexes report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)

        # Get database sizes
        db_sizes_query = f'last_over_time(pgwatch_db_size_size_b{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        db_sizes_result = self.query_instant(db_sizes_query)
        database_sizes = {}

        if db_sizes_result.get('status') == 'success' and db_sizes_result.get('data', {}).get('result'):
            for result in db_sizes_result['data']['result']:
                db_name = result['metric'].get('datname', 'unknown')
                size_bytes = float(result['value'][1])
                database_sizes[db_name] = size_bytes

        invalid_indexes_by_db = {}
        for db_name in databases:
            # Query invalid indexes for each database
            invalid_indexes_query = f'last_over_time(pgwatch_pg_invalid_indexes{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}[3h])'
            result = self.query_instant(invalid_indexes_query)

            invalid_indexes = []
            total_size = 0

            if result.get('status') == 'success' and result.get('data', {}).get('result'):
                for item in result['data']['result']:
                    # Extract index information from labels and values
                    schema_name = item['metric'].get('schema_name', 'unknown')
                    table_name = item['metric'].get('table_name', 'unknown')
                    index_name = item['metric'].get('index_name', 'unknown')
                    relation_name = item['metric'].get('relation_name', f"{schema_name}.{table_name}")

                    # Get index size from the metric value
                    index_size_bytes = float(item['value'][1]) if item.get('value') else 0
                    supports_fk = item['metric'].get('supports_fk', '0')

                    invalid_index = {
                        "schema_name": schema_name,
                        "table_name": table_name,
                        "index_name": index_name,
                        "relation_name": relation_name,
                        "index_size_bytes": index_size_bytes,
                        "index_size_pretty": self.format_bytes(index_size_bytes),
                        "supports_fk": bool(int(supports_fk))
                    }

                    invalid_indexes.append(invalid_index)
                    total_size += index_size_bytes

            db_size_bytes = database_sizes.get(db_name, 0)
            invalid_indexes_by_db[db_name] = {
                "invalid_indexes": invalid_indexes,
                "total_count": len(invalid_indexes),
                "total_size_bytes": total_size,
                "total_size_pretty": self.format_bytes(total_size),
                "database_size_bytes": db_size_bytes,
                "database_size_pretty": self.format_bytes(db_size_bytes)
            }

        return self.format_report_data(
            "H001",
            invalid_indexes_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_h002_unused_indexes_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
        """
        Generate H002 Unused Indexes report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing unused indexes information
        """
        print("Generating H002 Unused Indexes report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)

        # Get database sizes
        db_sizes_query = f'last_over_time(pgwatch_db_size_size_b{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        db_sizes_result = self.query_instant(db_sizes_query)
        database_sizes = {}

        if db_sizes_result.get('status') == 'success' and db_sizes_result.get('data', {}).get('result'):
            for result in db_sizes_result['data']['result']:
                db_name = result['metric'].get('datname', 'unknown')
                size_bytes = float(result['value'][1])
                database_sizes[db_name] = size_bytes

        # Query postmaster uptime to get startup time
        postmaster_uptime_query = f'last_over_time(pgwatch_db_stats_postmaster_uptime_s{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        postmaster_uptime_result = self.query_instant(postmaster_uptime_query)
        
        postmaster_startup_time = None
        postmaster_startup_epoch = None
        if postmaster_uptime_result.get('status') == 'success' and postmaster_uptime_result.get('data', {}).get('result'):
            uptime_seconds = float(postmaster_uptime_result['data']['result'][0]['value'][1]) if postmaster_uptime_result['data']['result'] else None
            if uptime_seconds:
                postmaster_startup_epoch = datetime.now().timestamp() - uptime_seconds
                postmaster_startup_time = datetime.fromtimestamp(postmaster_startup_epoch).isoformat()

        unused_indexes_by_db = {}
        for db_name in databases:
            # Get index definitions from Postgres sink database for this specific database
            index_definitions = self.get_index_definitions_from_sink(db_name)
            # Query stats_reset timestamp for this database
            stats_reset_query = f'last_over_time(pgwatch_stats_reset_stats_reset_epoch{{cluster="{cluster}", node_name="{node_name}", dbname="{db_name}"}}[3h])'
            stats_reset_result = self.query_instant(stats_reset_query)
            
            stats_reset_epoch = None
            days_since_reset = None
            stats_reset_time = None
            
            if stats_reset_result.get('status') == 'success' and stats_reset_result.get('data', {}).get('result'):
                stats_reset_epoch = float(stats_reset_result['data']['result'][0]['value'][1]) if stats_reset_result['data']['result'] else None
                if stats_reset_epoch:
                    stats_reset_time = datetime.fromtimestamp(stats_reset_epoch).isoformat()
                    days_since_reset = (datetime.now() - datetime.fromtimestamp(stats_reset_epoch)).days

            # Query unused indexes for each database using last_over_time to get most recent value
            unused_indexes_query = f'last_over_time(pgwatch_unused_indexes_index_size_bytes{{cluster="{cluster}", node_name="{node_name}", dbname="{db_name}"}}[3h])'
            unused_result = self.query_instant(unused_indexes_query)

            unused_indexes = []
            if unused_result.get('status') == 'success' and unused_result.get('data', {}).get('result'):
                for item in unused_result['data']['result']:
                    schema_name = item['metric'].get('schema_name', 'unknown')
                    table_name = item['metric'].get('table_name', 'unknown')
                    index_name = item['metric'].get('index_name', 'unknown')
                    reason = item['metric'].get('reason', 'Unknown')

                    # Get the index size from the metric value
                    index_size_bytes = float(item['value'][1]) if item.get('value') else 0

                    # Query other related metrics for this index
                    idx_scan_query = f'last_over_time(pgwatch_unused_indexes_idx_scan{{cluster="{cluster}", node_name="{node_name}", dbname="{db_name}", schema_name="{schema_name}", table_name="{table_name}", index_name="{index_name}"}}[3h])'
                    idx_scan_result = self.query_instant(idx_scan_query)
                    idx_scan = float(idx_scan_result['data']['result'][0]['value'][1]) if idx_scan_result.get('data',
                                                                                                              {}).get(
                        'result') else 0

                    # Get index definition from collected metrics
                    index_definition = index_definitions.get(index_name, 'Definition not available')

                    index_data = {
                        "schema_name": schema_name,
                        "table_name": table_name,
                        "index_name": index_name,
                        "index_definition": index_definition,
                        "reason": reason,
                        "idx_scan": idx_scan,
                        "index_size_bytes": index_size_bytes,
                        "idx_is_btree": item['metric'].get('idx_is_btree', 'false') == 'true',
                        "supports_fk": bool(int(item['metric'].get('supports_fk', 0)))
                    }

                    index_data['index_size_pretty'] = self.format_bytes(index_data['index_size_bytes'])

                    unused_indexes.append(index_data)

            # Sort by index size descending
            unused_indexes.sort(key=lambda x: x['index_size_bytes'], reverse=True)
            
            total_unused_size = sum(idx['index_size_bytes'] for idx in unused_indexes)

            db_size_bytes = database_sizes.get(db_name, 0)
            unused_indexes_by_db[db_name] = {
                "unused_indexes": unused_indexes,
                "total_count": len(unused_indexes),
                "total_size_bytes": total_unused_size,
                "total_size_pretty": self.format_bytes(total_unused_size),
                "database_size_bytes": db_size_bytes,
                "database_size_pretty": self.format_bytes(db_size_bytes),
                "stats_reset": {
                    "stats_reset_epoch": stats_reset_epoch,
                    "stats_reset_time": stats_reset_time,
                    "days_since_reset": days_since_reset,
                    "postmaster_startup_epoch": postmaster_startup_epoch,
                    "postmaster_startup_time": postmaster_startup_time
                }
            }

        return self.format_report_data(
            "H002",
            unused_indexes_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_h004_redundant_indexes_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[
        str, Any]:
        """
        Generate H004 Redundant Indexes report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing redundant indexes information
        """
        print("Generating H004 Redundant Indexes report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)

        # Get database sizes
        db_sizes_query = f'last_over_time(pgwatch_db_size_size_b{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        db_sizes_result = self.query_instant(db_sizes_query)
        database_sizes = {}

        if db_sizes_result.get('status') == 'success' and db_sizes_result.get('data', {}).get('result'):
            for result in db_sizes_result['data']['result']:
                db_name = result['metric'].get('datname', 'unknown')
                size_bytes = float(result['value'][1])
                database_sizes[db_name] = size_bytes

        redundant_indexes_by_db = {}
        for db_name in databases:
            # Fetch index definitions from the sink for this database (used to aid remediation)
            index_definitions = self.get_index_definitions_from_sink(db_name)
            # Query redundant indexes for each database using last_over_time to get most recent value
            redundant_indexes_query = f'last_over_time(pgwatch_redundant_indexes_index_size_bytes{{cluster="{cluster}", node_name="{node_name}", dbname="{db_name}"}}[3h])'
            result = self.query_instant(redundant_indexes_query)

            redundant_indexes = []
            total_size = 0

            if result.get('status') == 'success' and result.get('data', {}).get('result'):
                for item in result['data']['result']:
                    schema_name = item['metric'].get('schema_name', 'unknown')
                    table_name = item['metric'].get('table_name', 'unknown')
                    index_name = item['metric'].get('index_name', 'unknown')
                    relation_name = item['metric'].get('relation_name', f"{schema_name}.{table_name}")
                    access_method = item['metric'].get('access_method', 'unknown')
                    reason = item['metric'].get('reason', 'Unknown')

                    # Get the index size from the metric value
                    index_size_bytes = float(item['value'][1]) if item.get('value') else 0

                    # Query other related metrics for this index
                    table_size_query = f'last_over_time(pgwatch_redundant_indexes_table_size_bytes{{cluster="{cluster}", node_name="{node_name}", dbname="{db_name}", schema_name="{schema_name}", table_name="{table_name}", index_name="{index_name}"}}[3h])'
                    table_size_result = self.query_instant(table_size_query)
                    table_size_bytes = float(
                        table_size_result['data']['result'][0]['value'][1]) if table_size_result.get('data', {}).get(
                        'result') else 0

                    index_usage_query = f'last_over_time(pgwatch_redundant_indexes_index_usage{{cluster="{cluster}", node_name="{node_name}", dbname="{db_name}", schema_name="{schema_name}", table_name="{table_name}", index_name="{index_name}"}}[3h])'
                    index_usage_result = self.query_instant(index_usage_query)
                    index_usage = float(index_usage_result['data']['result'][0]['value'][1]) if index_usage_result.get(
                        'data', {}).get('result') else 0

                    supports_fk_query = f'last_over_time(pgwatch_redundant_indexes_supports_fk{{cluster="{cluster}", node_name="{node_name}", dbname="{db_name}", schema_name="{schema_name}", table_name="{table_name}", index_name="{index_name}"}}[3h])'
                    supports_fk_result = self.query_instant(supports_fk_query)
                    supports_fk = bool(
                        int(supports_fk_result['data']['result'][0]['value'][1])) if supports_fk_result.get('data',
                                                                                                            {}).get(
                        'result') else False

                    redundant_index = {
                        "schema_name": schema_name,
                        "table_name": table_name,
                        "index_name": index_name,
                        "relation_name": relation_name,
                        "access_method": access_method,
                        "reason": reason,
                        "index_size_bytes": index_size_bytes,
                        "table_size_bytes": table_size_bytes,
                        "index_usage": index_usage,
                        "supports_fk": supports_fk,
                        "index_definition": index_definitions.get(index_name, 'Definition not available'),
                        "index_size_pretty": self.format_bytes(index_size_bytes),
                        "table_size_pretty": self.format_bytes(table_size_bytes)
                    }

                    redundant_indexes.append(redundant_index)
                    total_size += index_size_bytes

            # Sort by index size descending
            redundant_indexes.sort(key=lambda x: x['index_size_bytes'], reverse=True)

            db_size_bytes = database_sizes.get(db_name, 0)
            redundant_indexes_by_db[db_name] = {
                "redundant_indexes": redundant_indexes,
                "total_count": len(redundant_indexes),
                "total_size_bytes": total_size,
                "total_size_pretty": self.format_bytes(total_size),
                "database_size_bytes": db_size_bytes,
                "database_size_pretty": self.format_bytes(db_size_bytes)
            }

        return self.format_report_data(
            "H004",
            redundant_indexes_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_d004_pgstat_settings_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[
        str, Any]:
        """
        Generate D004 pgstatstatements and pgstatkcache Settings report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing pg_stat_statements and pg_stat_kcache settings information
        """
        print("Generating D004 pgstatstatements and pgstatkcache Settings report...")

        # Define relevant pg_stat_statements and pg_stat_kcache settings
        pgstat_settings = [
            'pg_stat_statements.max',
            'pg_stat_statements.track',
            'pg_stat_statements.track_utility',
            'pg_stat_statements.save',
            'pg_stat_statements.track_planning',
            'shared_preload_libraries',
            'track_activities',
            'track_counts',
            'track_functions',
            'track_io_timing',
            'track_wal_io_timing'
        ]

        # Query all PostgreSQL settings for pg_stat_statements and related using last_over_time
        settings_query = f'last_over_time(pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        result = self.query_instant(settings_query)

        pgstat_data = {}
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                setting_name = item['metric'].get('setting_name', '')
                
                # Skip if no setting name
                if not setting_name:
                    continue

                # Filter for pg_stat_statements and related settings
                if setting_name in pgstat_settings:
                    setting_value = item['metric'].get('setting_value', '')
                    category = item['metric'].get('category', 'Statistics')
                    unit = item['metric'].get('unit', '')
                    context = item['metric'].get('context', '')
                    vartype = item['metric'].get('vartype', '')

                    pgstat_data[setting_name] = {
                        "setting": setting_value,
                        "unit": unit,
                        "category": category,
                        "context": context,
                        "vartype": vartype,
                        "pretty_value": self.format_setting_value(setting_name, setting_value, unit)
                    }
        else:
            print(f"Warning: D004 - No settings data returned for cluster={cluster}, node_name={node_name}")

        # Check if pg_stat_kcache extension is available and working by querying its metrics
        kcache_status = self._check_pg_stat_kcache_status(cluster, node_name)

        # Check if pg_stat_statements is available and working by querying its metrics  
        pgss_status = self._check_pg_stat_statements_status(cluster, node_name)

        return self.format_report_data(
            "D004",
            {
                "settings": pgstat_data,
                "pg_stat_statements_status": pgss_status,
                "pg_stat_kcache_status": kcache_status,
            },
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def _check_pg_stat_kcache_status(self, cluster: str, node_name: str) -> Dict[str, Any]:
        """
        Check if pg_stat_kcache extension is working by querying its metrics.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing pg_stat_kcache status information
        """
        kcache_queries = {
            'exec_user_time': f'last_over_time(pgwatch_pg_stat_kcache_exec_user_time{{cluster="{cluster}", node_name="{node_name}"}}[3h])',
            'exec_system_time': f'last_over_time(pgwatch_pg_stat_kcache_exec_system_time{{cluster="{cluster}", node_name="{node_name}"}}[3h])',
            'exec_total_time': f'last_over_time(pgwatch_pg_stat_kcache_exec_total_time{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        }

        kcache_status = {
            "extension_available": False,
            "metrics_count": 0,
            "total_exec_time": 0,
            "total_user_time": 0,
            "total_system_time": 0,
            "sample_queries": []
        }

        for metric_name, query in kcache_queries.items():
            result = self.query_instant(query)
            if result.get('status') == 'success' and result.get('data', {}).get('result'):
                kcache_status["extension_available"] = True
                results = result['data']['result']

                for item in results[:5]:  # Get sample of top 5 queries
                    queryid = item['metric'].get('queryid', 'unknown')
                    user = item['metric'].get('tag_user', 'unknown')
                    value = float(item['value'][1]) if item.get('value') else 0

                    # Add to totals
                    if metric_name == 'exec_total_time':
                        kcache_status["total_exec_time"] += value
                        kcache_status["metrics_count"] = len(results)

                        # Store sample query info
                        if len(kcache_status["sample_queries"]) < 5:
                            kcache_status["sample_queries"].append({
                                "queryid": queryid,
                                "user": user,
                                "exec_total_time": value
                            })
                    elif metric_name == 'exec_user_time':
                        kcache_status["total_user_time"] += value
                    elif metric_name == 'exec_system_time':
                        kcache_status["total_system_time"] += value

        return kcache_status

    def _check_pg_stat_statements_status(self, cluster: str, node_name: str) -> Dict[str, Any]:
        """
        Check if pg_stat_statements extension is working by querying its metrics.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing pg_stat_statements status information
        """
        pgss_query = f'last_over_time(pgwatch_pg_stat_statements_calls{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        result = self.query_instant(pgss_query)

        pgss_status = {
            "extension_available": False,
            "metrics_count": 0,
            "total_calls": 0,
            "sample_queries": []
        }

        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            pgss_status["extension_available"] = True
            results = result['data']['result']
            pgss_status["metrics_count"] = len(results)

            for item in results[:5]:  # Get sample of top 5 queries
                queryid = item['metric'].get('queryid', 'unknown')
                user = item['metric'].get('tag_user', 'unknown')
                datname = item['metric'].get('datname', 'unknown')
                calls = float(item['value'][1]) if item.get('value') else 0

                pgss_status["total_calls"] += calls

                # Store sample query info
                if len(pgss_status["sample_queries"]) < 5:
                    pgss_status["sample_queries"].append({
                        "queryid": queryid,
                        "user": user,
                        "database": datname,
                        "calls": calls
                    })

        return pgss_status

    def generate_f001_autovacuum_settings_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[
        str, Any]:
        """
        Generate F001 Autovacuum: Current Settings report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing autovacuum settings information
        """
        print("Generating F001 Autovacuum: Current Settings report...")

        # Define autovacuum related settings
        autovacuum_settings = [
            'autovacuum',
            'autovacuum_analyze_scale_factor',
            'autovacuum_analyze_threshold',
            'autovacuum_freeze_max_age',
            'autovacuum_max_workers',
            'autovacuum_multixact_freeze_max_age',
            'autovacuum_naptime',
            'autovacuum_vacuum_cost_delay',
            'autovacuum_vacuum_cost_limit',
            'autovacuum_vacuum_insert_scale_factor',
            'autovacuum_vacuum_scale_factor',
            'autovacuum_vacuum_threshold',
            'autovacuum_work_mem',
            'vacuum_cost_delay',
            'vacuum_cost_limit',
            'vacuum_cost_page_dirty',
            'vacuum_cost_page_hit',
            'vacuum_cost_page_miss',
            'vacuum_freeze_min_age',
            'vacuum_freeze_table_age',
            'vacuum_multixact_freeze_min_age',
            'vacuum_multixact_freeze_table_age'
        ]

        # Query all PostgreSQL settings for autovacuum using last_over_time
        settings_query = f'last_over_time(pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        result = self.query_instant(settings_query)

        autovacuum_data = {}
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                setting_name = item['metric'].get('setting_name', 'unknown')

                # Filter for autovacuum and vacuum settings
                if setting_name in autovacuum_settings:
                    setting_value = item['metric'].get('setting_value', '')
                    category = item['metric'].get('category', 'Autovacuum')
                    unit = item['metric'].get('unit', '')
                    context = item['metric'].get('context', '')
                    vartype = item['metric'].get('vartype', '')

                    autovacuum_data[setting_name] = {
                        "setting": setting_value,
                        "unit": unit,
                        "category": category,
                        "context": context,
                        "vartype": vartype,
                        "pretty_value": self.format_setting_value(setting_name, setting_value, unit)
                    }

        return self.format_report_data("F001", autovacuum_data, node_name, postgres_version=self._get_postgres_version_info(cluster, node_name))

    def generate_f005_btree_bloat_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
        """
        Generate F005 Autovacuum: Btree Index Bloat (Estimated) report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing btree index bloat information
        """
        print("Generating F005 Autovacuum: Btree Index Bloat (Estimated) report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)

        # Get database sizes
        db_sizes_query = f'last_over_time(pgwatch_db_size_size_b{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        db_sizes_result = self.query_instant(db_sizes_query)
        database_sizes = {}

        if db_sizes_result.get('status') == 'success' and db_sizes_result.get('data', {}).get('result'):
            for result in db_sizes_result['data']['result']:
                db_name = result['metric'].get('datname', 'unknown')
                size_bytes = float(result['value'][1])
                database_sizes[db_name] = size_bytes

        bloated_indexes_by_db = {}
        for db_name in databases:
            # Query btree bloat using multiple metrics for each database with last_over_time [1d]
            bloat_queries = {
                'extra_size': f'last_over_time(pgwatch_pg_btree_bloat_extra_size{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}[3h])',
                'extra_pct': f'last_over_time(pgwatch_pg_btree_bloat_extra_pct{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}[3h])',
                'bloat_size': f'last_over_time(pgwatch_pg_btree_bloat_bloat_size{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}[3h])',
                'bloat_pct': f'last_over_time(pgwatch_pg_btree_bloat_bloat_pct{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}[3h])',
            }

            bloated_indexes = {}

            for metric_type, query in bloat_queries.items():
                result = self.query_instant(query)
                if result.get('status') == 'success' and result.get('data', {}).get('result'):
                    for item in result['data']['result']:
                        schema_name = item['metric'].get('schemaname', 'unknown')
                        table_name = item['metric'].get('tblname', 'unknown')
                        index_name = item['metric'].get('idxname', 'unknown')

                        index_key = f"{schema_name}.{table_name}.{index_name}"

                        if index_key not in bloated_indexes:
                            bloated_indexes[index_key] = {
                                "schema_name": schema_name,
                                "table_name": table_name,
                                "index_name": index_name,
                                "extra_size": 0,
                                "extra_pct": 0,
                                "bloat_size": 0,
                                "bloat_pct": 0,
                            }

                        value = float(item['value'][1]) if item.get('value') else 0
                        bloated_indexes[index_key][metric_type] = value

            # Convert to list and add pretty formatting
            bloated_indexes_list = []
            total_bloat_size = 0

            for index_data in bloated_indexes.values():
                index_data['extra_size_pretty'] = self.format_bytes(index_data['extra_size'])
                index_data['bloat_size_pretty'] = self.format_bytes(index_data['bloat_size'])

                bloated_indexes_list.append(index_data)
                total_bloat_size += index_data['bloat_size']

            # Sort by bloat percentage descending
            bloated_indexes_list.sort(key=lambda x: x['bloat_pct'], reverse=True)

            db_size_bytes = database_sizes.get(db_name, 0)
            bloated_indexes_by_db[db_name] = {
                "bloated_indexes": bloated_indexes_list,
                "total_count": len(bloated_indexes_list),
                "total_bloat_size_bytes": total_bloat_size,
                "total_bloat_size_pretty": self.format_bytes(total_bloat_size),
                "database_size_bytes": db_size_bytes,
                "database_size_pretty": self.format_bytes(db_size_bytes)
            }

        return self.format_report_data(
            "F005",
            bloated_indexes_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_g001_memory_settings_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[
        str, Any]:
        """
        Generate G001 Memory-related Settings report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing memory-related settings information
        """
        print("Generating G001 Memory-related Settings report...")

        # Define memory-related settings
        memory_settings = [
            'shared_buffers',
            'work_mem',
            'maintenance_work_mem',
            'effective_cache_size',
            'autovacuum_work_mem',
            'max_wal_size',
            'min_wal_size',
            'wal_buffers',
            'checkpoint_completion_target',
            'max_connections',
            'max_prepared_transactions',
            'max_locks_per_transaction',
            'max_pred_locks_per_transaction',
            'max_pred_locks_per_relation',
            'max_pred_locks_per_page',
            'logical_decoding_work_mem',
            'hash_mem_multiplier',
            'temp_buffers',
            'shared_preload_libraries',
            'dynamic_shared_memory_type',
            'huge_pages',
            'max_files_per_process',
            'max_stack_depth'
        ]

        # Query all PostgreSQL settings for memory-related settings using last_over_time
        settings_query = f'last_over_time(pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        result = self.query_instant(settings_query)

        memory_data = {}
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                setting_name = item['metric'].get('setting_name', '')
                
                # Skip if no setting name
                if not setting_name:
                    continue

                # Filter for memory-related settings
                if setting_name in memory_settings:
                    setting_value = item['metric'].get('setting_value', '')
                    category = item['metric'].get('category', 'Memory')
                    unit = item['metric'].get('unit', '')
                    context = item['metric'].get('context', '')
                    vartype = item['metric'].get('vartype', '')

                    memory_data[setting_name] = {
                        "setting": setting_value,
                        "unit": unit,
                        "category": category,
                        "context": context,
                        "vartype": vartype,
                        "pretty_value": self.format_setting_value(setting_name, setting_value, unit)
                    }
        else:
            print(f"Warning: G001 - No settings data returned for cluster={cluster}, node_name={node_name}")

        # Calculate some memory usage estimates and recommendations
        memory_analysis = self._analyze_memory_settings(memory_data)

        return self.format_report_data(
            "G001",
            {
                "settings": memory_data,
                "analysis": memory_analysis,
            },
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def _analyze_memory_settings(self, memory_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Analyze memory settings and provide estimates and recommendations.
        
        Args:
            memory_data: Dictionary of memory settings
            
        Returns:
            Dictionary containing memory analysis
        """
        analysis = {
            "estimated_total_memory_usage": {}
        }

        try:
            # Extract key memory values for analysis
            shared_buffers = self._parse_memory_value(memory_data.get('shared_buffers', {}).get('setting', '128MB'))
            work_mem = self._parse_memory_value(memory_data.get('work_mem', {}).get('setting', '4MB'))
            maintenance_work_mem = self._parse_memory_value(
                memory_data.get('maintenance_work_mem', {}).get('setting', '64MB'))
            effective_cache_size = self._parse_memory_value(
                memory_data.get('effective_cache_size', {}).get('setting', '4GB'))
            max_connections = int(memory_data.get('max_connections', {}).get('setting', '100'))
            wal_buffers = self._parse_memory_value(memory_data.get('wal_buffers', {}).get('setting', '16MB'))

            # Calculate estimated memory usage
            shared_memory = shared_buffers + wal_buffers
            potential_work_mem_usage = work_mem * max_connections  # Worst case scenario

            analysis["estimated_total_memory_usage"] = {
                "shared_buffers_bytes": shared_buffers,
                "shared_buffers_pretty": self.format_bytes(shared_buffers),
                "wal_buffers_bytes": wal_buffers,
                "wal_buffers_pretty": self.format_bytes(wal_buffers),
                "shared_memory_total_bytes": shared_memory,
                "shared_memory_total_pretty": self.format_bytes(shared_memory),
                "work_mem_per_connection_bytes": work_mem,
                "work_mem_per_connection_pretty": self.format_bytes(work_mem),
                "max_work_mem_usage_bytes": potential_work_mem_usage,
                "max_work_mem_usage_pretty": self.format_bytes(potential_work_mem_usage),
                "maintenance_work_mem_bytes": maintenance_work_mem,
                "maintenance_work_mem_pretty": self.format_bytes(maintenance_work_mem),
                "effective_cache_size_bytes": effective_cache_size,
                "effective_cache_size_pretty": self.format_bytes(effective_cache_size)
            }

            # Generate recommendations                            
        except (ValueError, TypeError) as e:
            # If parsing fails, return empty analysis
            analysis["estimated_total_memory_usage"] = {}

        return analysis

    def _parse_memory_value(self, value: str) -> int:
        """
        Parse a PostgreSQL memory value string to bytes.
        
        Args:
            value: Memory value string (e.g., "128MB", "4GB", "8192")
            
        Returns:
            Memory value in bytes
        """
        if not value or value == '-1':
            return 0

        value = str(value).strip().upper()

        # Handle unit suffixes
        if value.endswith('TB'):
            return int(float(value[:-2]) * 1024 * 1024 * 1024 * 1024)
        elif value.endswith('GB'):
            return int(float(value[:-2]) * 1024 * 1024 * 1024)
        elif value.endswith('MB'):
            return int(float(value[:-2]) * 1024 * 1024)
        elif value.endswith('KB'):
            return int(float(value[:-2]) * 1024)
        elif value.endswith('B'):
            return int(float(value[:-1]))
        else:
            # Assume it's in the PostgreSQL default unit (typically 8KB blocks for some settings)
            try:
                numeric_value = int(value)
                # For most memory settings, bare numbers are in KB or 8KB blocks
                # This is a simplified assumption - in reality it depends on the specific setting
                return numeric_value * 1024  # Assume KB if no unit specified
            except ValueError:
                return 0

    def generate_f004_heap_bloat_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
        """
        Generate F004 Autovacuum: Heap Bloat (Estimated) report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing heap bloat information
        """
        print("Generating F004 Autovacuum: Heap Bloat (Estimated) report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)
        
        if not databases:
            print("Warning: F004 - No databases found")

        # Get database sizes
        db_sizes_query = f'last_over_time(pgwatch_db_size_size_b{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        db_sizes_result = self.query_instant(db_sizes_query)
        database_sizes = {}

        if db_sizes_result.get('status') == 'success' and db_sizes_result.get('data', {}).get('result'):
            for result in db_sizes_result['data']['result']:
                db_name = result['metric'].get('datname', 'unknown')
                size_bytes = float(result['value'][1])
                database_sizes[db_name] = size_bytes

        bloated_tables_by_db = {}
        for db_name in databases:
            # Query table bloat using multiple metrics for each database
            # Try with 10h window first, then fall back to instant query
            bloat_queries = {
                'real_size': f'last_over_time(pgwatch_pg_table_bloat_real_size{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}[3h])',
                'extra_size': f'last_over_time(pgwatch_pg_table_bloat_extra_size{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}[3h])',
                'extra_pct': f'last_over_time(pgwatch_pg_table_bloat_extra_pct{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}[3h])',
                'bloat_size': f'last_over_time(pgwatch_pg_table_bloat_bloat_size{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}[3h])',
                'bloat_pct': f'last_over_time(pgwatch_pg_table_bloat_bloat_pct{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}[3h])',
            }

            bloated_tables = {}
            for metric_type, query in bloat_queries.items():
                result = self.query_instant(query)
                if result.get('status') == 'success' and result.get('data', {}).get('result'):
                    for item in result['data']['result']:
                        schema_name = item['metric'].get('schemaname', 'unknown')
                        table_name = item['metric'].get('tblname', 'unknown')

                        table_key = f"{schema_name}.{table_name}"

                        if table_key not in bloated_tables:
                            bloated_tables[table_key] = {
                                "schema_name": schema_name,
                                "table_name": table_name,
                                "real_size": 0,
                                "extra_size": 0,
                                "extra_pct": 0,
                                "bloat_size": 0,
                                "bloat_pct": 0,
                            }

                        value = float(item['value'][1]) if item.get('value') else 0
                        bloated_tables[table_key][metric_type] = value
                else:
                    if metric_type == 'real_size':  # Only log once per database
                        print(f"Warning: F004 - No bloat data for database {db_name}, metric {metric_type}")

            # Convert to list and add pretty formatting
            bloated_tables_list = []
            total_bloat_size = 0

            for table_data in bloated_tables.values():
                table_data['real_size_pretty'] = self.format_bytes(table_data['real_size'])
                table_data['extra_size_pretty'] = self.format_bytes(table_data['extra_size'])
                table_data['bloat_size_pretty'] = self.format_bytes(table_data['bloat_size'])

                bloated_tables_list.append(table_data)
                total_bloat_size += table_data['bloat_size']

            # Sort by bloat percentage descending
            bloated_tables_list.sort(key=lambda x: x['bloat_pct'], reverse=True)

            db_size_bytes = database_sizes.get(db_name, 0)
            bloated_tables_by_db[db_name] = {
                "bloated_tables": bloated_tables_list,
                "total_count": len(bloated_tables_list),
                "total_bloat_size_bytes": total_bloat_size,
                "total_bloat_size_pretty": self.format_bytes(total_bloat_size),
                "database_size_bytes": db_size_bytes,
                "database_size_pretty": self.format_bytes(db_size_bytes)
            }

        return self.format_report_data(
            "F004",
            bloated_tables_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_k001_query_calls_report(self, cluster: str = "local", node_name: str = "node-01",
                                         time_range_minutes: int = 60) -> Dict[str, Any]:
        """
        Generate K001 Globally Aggregated Query Metrics report (sorted by calls).
        
        Args:
            cluster: Cluster name
            node_name: Node name
            time_range_minutes: Time range in minutes for metrics collection
            
        Returns:
            Dictionary containing query metrics sorted by calls
        """
        print("Generating K001 Globally Aggregated Query Metrics report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)
        
        if not databases:
            print("Warning: K001 - No databases found")

        # Calculate time range
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=time_range_minutes)

        queries_by_db = {}
        for db_name in databases:
            print(f"K001: Processing database {db_name}...")
            # Get pg_stat_statements metrics for this database
            query_metrics = self._get_pgss_metrics_data_by_db(cluster, node_name, db_name, start_time, end_time)

            if not query_metrics:
                print(f"Warning: K001 - No query metrics returned for database {db_name}")

            # Sort by calls (descending)
            sorted_metrics = sorted(query_metrics, key=lambda x: x.get('calls', 0), reverse=True)

            # Calculate totals for this database
            total_calls = sum(q.get('calls', 0) for q in sorted_metrics)
            total_time = sum(q.get('total_time', 0) for q in sorted_metrics)
            total_rows = sum(q.get('rows', 0) for q in sorted_metrics)

            queries_by_db[db_name] = {
                "query_metrics": sorted_metrics,
                "summary": {
                    "total_queries": len(sorted_metrics),
                    "total_calls": total_calls,
                    "total_time_ms": total_time,
                    "total_rows": total_rows,
                    "time_range_minutes": time_range_minutes,
                    "start_time": start_time.isoformat(),
                    "end_time": end_time.isoformat()
                }
            }

        return self.format_report_data(
            "K001",
            queries_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_k003_top_queries_report(self, cluster: str = "local", node_name: str = "node-01",
                                         time_range_minutes: int = 60, limit: int = 50) -> Dict[str, Any]:
        """
        Generate K003 Top-50 Queries by total_time report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            time_range_minutes: Time range in minutes for metrics collection
            limit: Number of top queries to return (default: 50)
            
        Returns:
            Dictionary containing top queries sorted by total execution time
        """
        print("Generating K003 Top-50 Queries by total_time report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)
        
        if not databases:
            print("Warning: K003 - No databases found")

        # Calculate time range
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=time_range_minutes)

        queries_by_db = {}
        for db_name in databases:
            print(f"K003: Processing database {db_name}...")
            # Get pg_stat_statements metrics for this database
            query_metrics = self._get_pgss_metrics_data_by_db(cluster, node_name, db_name, start_time, end_time)

            if not query_metrics:
                print(f"Warning: K003 - No query metrics returned for database {db_name}")

            # Sort by total_time (descending) and limit to top N per database
            sorted_metrics = sorted(query_metrics, key=lambda x: x.get('total_time', 0), reverse=True)[:limit]

            # Calculate totals for the top queries in this database
            total_calls = sum(q.get('calls', 0) for q in sorted_metrics)
            total_time = sum(q.get('total_time', 0) for q in sorted_metrics)
            total_rows = sum(q.get('rows', 0) for q in sorted_metrics)

            queries_by_db[db_name] = {
                "top_queries": sorted_metrics,
                "summary": {
                    "queries_returned": len(sorted_metrics),
                    "total_calls": total_calls,
                    "total_time_ms": total_time,
                    "total_rows": total_rows,
                    "time_range_minutes": time_range_minutes,
                    "start_time": start_time.isoformat(),
                    "end_time": end_time.isoformat(),
                    "limit": limit
                }
            }

        return self.format_report_data(
            "K003",
            queries_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_m001_mean_time_report(self, cluster: str = "local", node_name: str = "node-01",
                                       time_range_minutes: int = 60, limit: int = 50) -> Dict[str, Any]:
        """
        Generate M001 Top-50 Queries by mean execution time report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            time_range_minutes: Time range in minutes for metrics collection
            limit: Number of top queries to return (default: 50)
            
        Returns:
            Dictionary containing top queries sorted by mean execution time
        """
        print("Generating M001 Top-50 Queries by mean execution time report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)
        
        if not databases:
            print("Warning: M001 - No databases found")

        # Calculate time range
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=time_range_minutes)

        queries_by_db = {}
        for db_name in databases:
            print(f"M001: Processing database {db_name}...")
            # Get pg_stat_statements metrics for this database
            query_metrics = self._get_pgss_metrics_data_by_db(cluster, node_name, db_name, start_time, end_time)

            if not query_metrics:
                print(f"Warning: M001 - No query metrics returned for database {db_name}")

            # Calculate mean execution time for each query
            queries_with_mean = []
            for q in query_metrics:
                calls = q.get('calls', 0)
                total_time = q.get('total_time', 0)
                if calls > 0:
                    mean_time = total_time / calls
                    q['mean_time'] = mean_time
                    queries_with_mean.append(q)

            # Sort by mean_time (descending) and limit to top N per database
            sorted_metrics = sorted(queries_with_mean, key=lambda x: x.get('mean_time', 0), reverse=True)[:limit]

            # Calculate totals for the top queries in this database
            total_calls = sum(q.get('calls', 0) for q in sorted_metrics)
            total_time = sum(q.get('total_time', 0) for q in sorted_metrics)
            total_rows = sum(q.get('rows', 0) for q in sorted_metrics)

            queries_by_db[db_name] = {
                "top_queries": sorted_metrics,
                "summary": {
                    "queries_returned": len(sorted_metrics),
                    "total_calls": total_calls,
                    "total_time_ms": total_time,
                    "total_rows": total_rows,
                    "time_range_minutes": time_range_minutes,
                    "start_time": start_time.isoformat(),
                    "end_time": end_time.isoformat(),
                    "limit": limit
                }
            }

        return self.format_report_data(
            "M001",
            queries_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_m002_rows_report(self, cluster: str = "local", node_name: str = "node-01",
                                  time_range_minutes: int = 60, limit: int = 50) -> Dict[str, Any]:
        """
        Generate M002 Top-50 Queries by rows (I/O intensity) report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            time_range_minutes: Time range in minutes for metrics collection
            limit: Number of top queries to return (default: 50)
            
        Returns:
            Dictionary containing top queries sorted by rows processed
        """
        print("Generating M002 Top-50 Queries by rows report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)
        
        if not databases:
            print("Warning: M002 - No databases found")

        # Calculate time range
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=time_range_minutes)

        queries_by_db = {}
        for db_name in databases:
            print(f"M002: Processing database {db_name}...")
            # Get pg_stat_statements metrics for this database
            query_metrics = self._get_pgss_metrics_data_by_db(cluster, node_name, db_name, start_time, end_time)

            if not query_metrics:
                print(f"Warning: M002 - No query metrics returned for database {db_name}")

            # Sort by rows (descending) and limit to top N per database
            sorted_metrics = sorted(query_metrics, key=lambda x: x.get('rows', 0), reverse=True)[:limit]

            # Calculate totals for the top queries in this database
            total_calls = sum(q.get('calls', 0) for q in sorted_metrics)
            total_time = sum(q.get('total_time', 0) for q in sorted_metrics)
            total_rows = sum(q.get('rows', 0) for q in sorted_metrics)

            queries_by_db[db_name] = {
                "top_queries": sorted_metrics,
                "summary": {
                    "queries_returned": len(sorted_metrics),
                    "total_calls": total_calls,
                    "total_time_ms": total_time,
                    "total_rows": total_rows,
                    "time_range_minutes": time_range_minutes,
                    "start_time": start_time.isoformat(),
                    "end_time": end_time.isoformat(),
                    "limit": limit
                }
            }

        return self.format_report_data(
            "M002",
            queries_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_m003_io_time_report(self, cluster: str = "local", node_name: str = "node-01",
                                     time_range_minutes: int = 60, limit: int = 50) -> Dict[str, Any]:
        """
        Generate M003 Top-50 Queries by I/O time report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            time_range_minutes: Time range in minutes for metrics collection
            limit: Number of top queries to return (default: 50)
            
        Returns:
            Dictionary containing top queries sorted by total I/O time
        """
        print("Generating M003 Top-50 Queries by I/O time report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)
        
        if not databases:
            print("Warning: M003 - No databases found")

        # Calculate time range
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=time_range_minutes)

        queries_by_db = {}
        for db_name in databases:
            print(f"M003: Processing database {db_name}...")
            # Get pg_stat_statements metrics for this database
            query_metrics = self._get_pgss_metrics_data_by_db(cluster, node_name, db_name, start_time, end_time)

            if not query_metrics:
                print(f"Warning: M003 - No query metrics returned for database {db_name}")

            # Calculate total I/O time for each query
            queries_with_io_time = []
            for q in query_metrics:
                blk_read_time = q.get('blk_read_time', 0)
                blk_write_time = q.get('blk_write_time', 0)
                total_io_time = blk_read_time + blk_write_time
                q['total_io_time'] = total_io_time
                queries_with_io_time.append(q)

            # Sort by total_io_time (descending) and limit to top N per database
            sorted_metrics = sorted(queries_with_io_time, key=lambda x: x.get('total_io_time', 0), reverse=True)[:limit]

            # Calculate totals for the top queries in this database
            total_calls = sum(q.get('calls', 0) for q in sorted_metrics)
            total_time = sum(q.get('total_time', 0) for q in sorted_metrics)
            total_rows = sum(q.get('rows', 0) for q in sorted_metrics)
            total_io_time = sum(q.get('total_io_time', 0) for q in sorted_metrics)

            queries_by_db[db_name] = {
                "top_queries": sorted_metrics,
                "summary": {
                    "queries_returned": len(sorted_metrics),
                    "total_calls": total_calls,
                    "total_time_ms": total_time,
                    "total_rows": total_rows,
                    "total_io_time_ms": total_io_time,
                    "time_range_minutes": time_range_minutes,
                    "start_time": start_time.isoformat(),
                    "end_time": end_time.isoformat(),
                    "limit": limit
                }
            }

        return self.format_report_data(
            "M003",
            queries_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def generate_n001_wait_events_report(self, cluster: str = "local", node_name: str = "node-01",
                                         time_range_minutes: int = 60, sampling_interval_seconds: int = 15) -> Dict[str, Any]:
        """
        Generate N001 Wait Events report grouped by wait_event_type and query_id.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            time_range_minutes: Time range in minutes for metrics collection (default: 60)
            sampling_interval_seconds: Wait events sampling interval in seconds (default: 15)
            
        Returns:
            Dictionary containing wait events grouped by type and query_id with occurrences and time
        """
        print("Generating N001 Wait Events report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)
        
        if not databases:
            print("Warning: N001 - No databases found")

        # Calculate time range
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=time_range_minutes)

        wait_events_by_db = {}
        
        for db_name in databases:
            print(f"N001: Processing database {db_name}...")
            
            # Query wait events from Prometheus
            # pgwatch_wait_events_total has labels: wait_event_type, wait_event, query_id, datname
            filters = [
                f'cluster="{cluster}"',
                f'node_name="{node_name}"',
                f'datname="{db_name}"'
            ]
            filter_str = '{' + ','.join(filters) + '}'
            
            # Get wait events data over the time range
            metric_name = f'pgwatch_wait_events_total{filter_str}'
            
            try:
                result = self.query_range(metric_name, start_time, end_time, step="60s")
                
                if not result:
                    print(f"Warning: N001 - No wait events data for database {db_name}")
                    continue
                
                # Process results to group by wait_event_type -> query_id -> count and time
                wait_events_grouped = {}
                
                for series in result:
                    metric = series.get('metric', {})
                    wait_event_type = metric.get('wait_event_type', 'Unknown')
                    wait_event = metric.get('wait_event', 'Unknown')
                    query_id = metric.get('query_id', '0')
                    
                    # Get the values (timestamp, value pairs)
                    values = series.get('values', [])
                    
                    # Count occurrences (number of data points where wait event was observed)
                    # Sum the values to get total wait event count
                    # Each value represents the number of sessions in that wait state at that moment
                    total_count = 0
                    for timestamp, value in values:
                        try:
                            total_count += float(value)
                        except (ValueError, TypeError):
                            continue
                    
                    if total_count == 0:
                        continue
                    
                    # Calculate estimated time spent: occurrences * sampling_interval
                    # This gives us session-seconds spent in this wait state
                    time_seconds = total_count * sampling_interval_seconds
                    
                    # Group by wait_event_type
                    if wait_event_type not in wait_events_grouped:
                        wait_events_grouped[wait_event_type] = {
                            'queries': {},
                            'total_occurrences': 0,
                            'total_time_seconds': 0,
                            'unique_queries': 0
                        }
                    
                    # Add query_id under this wait_event_type
                    if query_id not in wait_events_grouped[wait_event_type]['queries']:
                        wait_events_grouped[wait_event_type]['queries'][query_id] = {
                            'occurrences': 0,
                            'time_seconds': 0,
                            'wait_events': {}
                        }
                    
                    # Track individual wait events within the type
                    wait_events_grouped[wait_event_type]['queries'][query_id]['wait_events'][wait_event] = {
                        'occurrences': int(total_count),
                        'time_seconds': round(time_seconds, 2)
                    }
                    wait_events_grouped[wait_event_type]['queries'][query_id]['occurrences'] += int(total_count)
                    wait_events_grouped[wait_event_type]['queries'][query_id]['time_seconds'] += time_seconds
                    wait_events_grouped[wait_event_type]['total_occurrences'] += int(total_count)
                    wait_events_grouped[wait_event_type]['total_time_seconds'] += time_seconds
                
                # Count unique queries per wait event type and round time values
                for wait_type in wait_events_grouped:
                    wait_events_grouped[wait_type]['unique_queries'] = len(wait_events_grouped[wait_type]['queries'])
                    wait_events_grouped[wait_type]['total_time_seconds'] = round(wait_events_grouped[wait_type]['total_time_seconds'], 2)
                
                # Sort queries by time spent within each wait event type
                for wait_type in wait_events_grouped:
                    queries_list = []
                    for query_id, data in wait_events_grouped[wait_type]['queries'].items():
                        queries_list.append({
                            'query_id': query_id,
                            'occurrences': data['occurrences'],
                            'time_seconds': round(data['time_seconds'], 2),
                            'wait_events': data['wait_events']
                        })
                    # Sort by time spent descending (primary), then occurrences (secondary)
                    queries_list.sort(key=lambda x: (x['time_seconds'], x['occurrences']), reverse=True)
                    wait_events_grouped[wait_type]['queries_list'] = queries_list
                    # Remove the dict version
                    del wait_events_grouped[wait_type]['queries']
                
                total_time_seconds = sum(wt['total_time_seconds'] for wt in wait_events_grouped.values())
                
                wait_events_by_db[db_name] = {
                    'wait_event_types': wait_events_grouped,
                    'summary': {
                        'time_range_minutes': time_range_minutes,
                        'start_time': start_time.isoformat(),
                        'end_time': end_time.isoformat(),
                        'wait_event_types_count': len(wait_events_grouped),
                        'total_occurrences': sum(wt['total_occurrences'] for wt in wait_events_grouped.values()),
                        'total_time_seconds': round(total_time_seconds, 2),
                        'sampling_interval_seconds': sampling_interval_seconds
                    }
                }
                
            except Exception as e:
                print(f"Error querying wait events for database {db_name}: {e}")
                continue

        return self.format_report_data(
            "N001",
            wait_events_by_db,
            node_name,
            postgres_version=self._get_postgres_version_info(cluster, node_name),
        )

    def _get_pgss_metrics_data(self, cluster: str, node_name: str, start_time: datetime, end_time: datetime) -> List[
        Dict[str, Any]]:
        """
        Get pg_stat_statements metrics data between two time points.
        Adapted from the logic in monitoring_flask_backend/app.py get_pgss_metrics_csv().
        
        Args:
            cluster: Cluster name
            node_name: Node name  
            start_time: Start datetime
            end_time: End datetime
            
        Returns:
            List of query metrics with calculated differences
        """
        # Metric name mapping for cleaner output
        METRIC_NAME_MAPPING = {
            'calls': 'calls',
            'exec_time_total': 'total_time',
            'rows': 'rows',
            'shared_bytes_hit_total': 'shared_blks_hit',
            'shared_bytes_read_total': 'shared_blks_read',
            'shared_bytes_dirtied_total': 'shared_blks_dirtied',
            'shared_bytes_written_total': 'shared_blks_written',
            'block_read_total': 'blk_read_time',
            'block_write_total': 'blk_write_time'
        }

        # Build filters
        filters = [f'cluster="{cluster}"', f'node_name="{node_name}"']
        filter_str = '{' + ','.join(filters) + '}'

        # Get all pg_stat_statements metrics
        all_metrics = [
            'pgwatch_pg_stat_statements_calls',
            'pgwatch_pg_stat_statements_exec_time_total',
            'pgwatch_pg_stat_statements_rows',
            'pgwatch_pg_stat_statements_shared_bytes_hit_total',
            'pgwatch_pg_stat_statements_shared_bytes_read_total',
            'pgwatch_pg_stat_statements_shared_bytes_dirtied_total',
            'pgwatch_pg_stat_statements_shared_bytes_written_total',
            'pgwatch_pg_stat_statements_block_read_total',
            'pgwatch_pg_stat_statements_block_write_total'
        ]

        # Get metrics at start and end times
        start_data = []
        end_data = []

        for metric in all_metrics:
            metric_with_filters = f'{metric}{filter_str}'

            try:
                # Query metrics around start time - use instant queries at specific timestamps
                start_result = self.query_range(metric_with_filters, start_time - timedelta(minutes=1),
                                                start_time + timedelta(minutes=1))
                if start_result:
                    start_data.extend(start_result)

                # Query metrics around end time  
                end_result = self.query_range(metric_with_filters, end_time - timedelta(minutes=1),
                                              end_time + timedelta(minutes=1))
                if end_result:
                    end_data.extend(end_result)

            except Exception as e:
                print(f"Warning: Failed to query metric {metric}: {e}")
                continue

        # Process the data to calculate differences
        return self._process_pgss_data(start_data, end_data, start_time, end_time, METRIC_NAME_MAPPING)

    def query_range(self, query: str, start_time: datetime, end_time: datetime, step: str = "30s") -> List[
        Dict[str, Any]]:
        """
        Execute a range PromQL query.
        
        Args:
            query: PromQL query string
            start_time: Start time
            end_time: End time
            step: Query step interval
            
        Returns:
            List of query results
        """
        params = {
            'query': query,
            'start': start_time.timestamp(),
            'end': end_time.timestamp(),
            'step': step
        }

        try:
            response = requests.get(f"{self.base_url}/query_range", params=params)
            if response.status_code == 200:
                result = response.json()
                if result.get('status') == 'success':
                    return result.get('data', {}).get('result', [])
            else:
                print(f"Range query failed with status {response.status_code}: {response.text}")
        except Exception as e:
            print(f"Range query error: {e}")

        return []

    def _process_pgss_data(self, start_data: List[Dict], end_data: List[Dict],
                           start_time: datetime, end_time: datetime,
                           metric_mapping: Dict[str, str]) -> List[Dict[str, Any]]:
        """
        Process pg_stat_statements data and calculate differences between start and end times.
        Adapted from the logic in monitoring_flask_backend/app.py process_pgss_data().
        """
        # Convert Prometheus data to dictionaries
        start_metrics = self._prometheus_to_dict(start_data, start_time)
        end_metrics = self._prometheus_to_dict(end_data, end_time)

        if not start_metrics and not end_metrics:
            return []

        # Create a combined dictionary with all unique query identifiers
        all_keys = set()
        all_keys.update(start_metrics.keys())
        all_keys.update(end_metrics.keys())

        result_rows = []

        # Calculate differences for each query
        for key in all_keys:
            start_metric = start_metrics.get(key, {})
            end_metric = end_metrics.get(key, {})

            # Extract identifier components from key
            db_name, query_id, user, instance = key

            # Calculate actual duration from metric timestamps
            start_timestamp = start_metric.get('timestamp')
            end_timestamp = end_metric.get('timestamp')

            if start_timestamp and end_timestamp:
                start_dt = datetime.fromisoformat(start_timestamp)
                end_dt = datetime.fromisoformat(end_timestamp)
                actual_duration = (end_dt - start_dt).total_seconds()
            else:
                # Fallback to query parameter duration if timestamps are missing
                actual_duration = (end_time - start_time).total_seconds()

            # Create result row
            row = {
                'queryid': query_id,
                'database': db_name,
                'user': user,
                'duration_seconds': actual_duration
            }

            # Numeric columns to calculate differences for (using original metric names)
            numeric_cols = list(metric_mapping.keys())

            # Calculate differences and rates
            for col in numeric_cols:
                start_val = start_metric.get(col, 0)
                end_val = end_metric.get(col, 0)
                diff = end_val - start_val

                # Use simplified display name
                display_name = metric_mapping[col]

                # Convert bytes to blocks for block-related metrics (PostgreSQL uses 8KB blocks)
                if 'blks' in display_name and 'bytes' in col:
                    diff = diff / 8192  # Convert bytes to 8KB blocks

                row[display_name] = diff

                # Calculate rates per second
                if row['duration_seconds'] > 0:
                    row[f'{display_name}_per_sec'] = diff / row['duration_seconds']
                else:
                    row[f'{display_name}_per_sec'] = 0

                # Calculate per-call averages
                calls_diff = row.get('calls', 0)
                if calls_diff > 0:
                    row[f'{display_name}_per_call'] = diff / calls_diff
                else:
                    row[f'{display_name}_per_call'] = 0

            result_rows.append(row)

        return result_rows

    def _prometheus_to_dict(self, prom_data: List[Dict], timestamp: datetime) -> Dict:
        """
        Convert Prometheus API response to dictionary keyed by query identifiers.
        Adapted from the logic in monitoring_flask_backend/app.py prometheus_to_dict().
        """
        if not prom_data:
            return {}

        metrics_dict = {}

        for metric_data in prom_data:
            metric = metric_data.get('metric', {})
            values = metric_data.get('values', [])

            if not values:
                continue

            # Get the closest value to our timestamp
            closest_value = min(values, key=lambda x: abs(float(x[0]) - timestamp.timestamp()))

            # Create unique key for this query
            # Note: 'user' label may not exist in all metric configurations
            key = (
                metric.get('datname', ''),
                metric.get('queryid', ''),
                metric.get('user', metric.get('tag_user', '')),  # Fallback to tag_user or empty
                metric.get('instance', '')
            )

            # Initialize metric dict if not exists
            if key not in metrics_dict:
                metrics_dict[key] = {
                    'timestamp': datetime.fromtimestamp(float(closest_value[0])).isoformat(),
                }

            # Add metric value
            metric_name = metric.get('__name__', 'pgwatch_pg_stat_statements_calls')
            clean_name = metric_name.replace('pgwatch_pg_stat_statements_', '')

            try:
                metrics_dict[key][clean_name] = float(closest_value[1])
            except (ValueError, IndexError):
                metrics_dict[key][clean_name] = 0

        return metrics_dict

    def format_bytes(self, bytes_value: float) -> str:
        """Format bytes value for human readable display."""
        if bytes_value == 0:
            return "0 B"

        units = ['B', 'KB', 'MB', 'GB', 'TB']
        unit_index = 0
        value = float(bytes_value)

        while value >= 1024 and unit_index < len(units) - 1:
            value /= 1024
            unit_index += 1

        if value >= 100:
            return f"{value:.0f} {units[unit_index]}"
        elif value >= 10:
            return f"{value:.1f} {units[unit_index]}"
        else:
            return f"{value:.2f} {units[unit_index]}"

    def format_report_data(self, check_id: str, data: Dict[str, Any], host: str = "target-database", 
                          all_hosts: Dict[str, List[str]] = None,
                          postgres_version: Dict[str, str] = None) -> Dict[str, Any]:
        """
        Format data to match template structure.
        
        Args:
            check_id: The check identifier
            data: The data to format (can be a dict with node keys if combining multiple nodes)
            host: Primary host identifier (used if all_hosts not provided)
            all_hosts: Optional dict with 'primary' and 'standbys' keys for multi-node reports
            postgres_version: Optional Postgres version info to include at report level
            
        Returns:
            Dictionary formatted for templates
        """
        now = datetime.now(timezone.utc)

        # If all_hosts is provided, use it; otherwise use the single host as primary
        if all_hosts:
            hosts = all_hosts
        else:
            hosts = {
                "primary": host,
                "standbys": [],
            }

        # Handle both single-node and multi-node data structures
        if isinstance(data, dict) and any(isinstance(v, dict) and 'data' in v for v in data.values()):
            # Multi-node structure: data is already in {node_name: {"data": ...}} format
            # postgres_version should already be embedded per-node; warn if passed here
            if postgres_version:
                print(f"Warning: postgres_version parameter ignored for multi-node data in {check_id}")
            results = data
        else:
            # Single-node structure: wrap data in host key
            node_result = {"data": data}
            if postgres_version:
                node_result["postgres_version"] = postgres_version
            results = {host: node_result}

        template_data = {
            "checkId": check_id,
            "checkTitle": self.get_check_title(check_id),
            "timestamptz": now.isoformat(),
            "nodes": hosts,
            "results": results
        }

        return template_data

    def get_check_title(self, check_id: str) -> str:
        """
        Get the human-readable title for a check ID.
        
        Args:
            check_id: The check identifier (e.g., "H004")
            
        Returns:
            Human-readable title for the check
        """
        # Mapping based on postgres-checkup README
        # https://gitlab.com/postgres-ai/postgres-checkup
        check_titles = {
            "A001": "System information",
            "A002": "Postgres major version",
            "A003": "Postgres settings",
            "A004": "Cluster information",
            "A005": "Extensions",
            "A006": "Postgres setting deviations",
            "A007": "Altered settings",
            "A008": "Disk usage and file system type",
            "A010": "Data checksums, wal_log_hints",
            "A011": "Connection pooling. pgbouncer",
            "A012": "Anti-crash checks",
            "A013": "Postgres minor version",
            "B001": "SLO/SLA, RPO, RTO",
            "B002": "File system, mount flags",
            "B003": "Full backups / incremental",
            "B004": "WAL archiving",
            "B005": "Restore checks, monitoring, alerting",
            "C001": "SLO/SLA",
            "C002": "Sync/async, Streaming / wal transfer; logical decoding",
            "C003": "SPOFs; standby with traffic",
            "C004": "Failover",
            "C005": "Switchover",
            "C006": "Delayed replica",
            "C007": "Replication slots. Lags. Standby feedbacks",
            "D001": "Logging settings",
            "D002": "Useful Linux tools",
            "D003": "List of monitoring metrics",
            "D004": "pg_stat_statements and pg_stat_kcache settings",
            "D005": "track_io_timing, auto_explain",
            "D006": "Recommended DBA toolsets",
            "D007": "Postgres-specific tools for troubleshooting",
            "E001": "WAL/checkpoint settings, IO",
            "E002": "Checkpoints, bgwriter, IO",
            "F001": "Autovacuum: current settings",
            "F002": "Autovacuum: transaction ID wraparound check",
            "F003": "Autovacuum: dead tuples",
            "F004": "Autovacuum: heap bloat (estimated)",
            "F005": "Autovacuum: index bloat (estimated)",
            "F006": "Precise heap bloat analysis",
            "F007": "Precise index bloat analysis",
            "F008": "Autovacuum: resource usage",
            "G001": "Memory-related settings",
            "G002": "Connections and current activity",
            "G003": "Timeouts, locks, deadlocks",
            "G004": "Query planner",
            "G005": "I/O settings",
            "G006": "Default_statistics_target",
            "H001": "Invalid indexes",
            "H002": "Unused indexes",
            "H003": "Non-indexed foreign keys",
            "H004": "Redundant indexes",
            "J001": "Capacity planning",
            "K001": "Globally aggregated query metrics",
            "K002": "Workload type",
            "K003": "Top-50 queries by total_time",
            "L001": "Table sizes",
            "M001": "Top-50 queries by mean execution time",
            "M002": "Top-50 queries by rows (I/O intensity)",
            "M003": "Top-50 queries by I/O time",
            "N001": "Wait events grouped by type and query",
            "L002": "Data types being used",
            "L003": "Integer out-of-range risks in PKs",
            "L004": "Tables without PK/UK",
        }
        return check_titles.get(check_id, f"Check {check_id}")

    def get_setting_unit(self, setting_name: str) -> str:
        """Get the unit for a PostgreSQL setting."""
        units = {
            'max_connections': 'connections',
            'shared_buffers': '8kB',
            'effective_cache_size': '8kB',
            'work_mem': 'kB',
            'maintenance_work_mem': 'kB',
            'checkpoint_completion_target': '',
            'wal_buffers': '8kB',
            'default_statistics_target': '',
            'random_page_cost': '',
            'effective_io_concurrency': '',
            'autovacuum_max_workers': 'workers',
            'autovacuum_naptime': 's',
            'log_min_duration_statement': 'ms',
            'idle_in_transaction_session_timeout': 'ms',
            'lock_timeout': 'ms',
            'statement_timeout': 'ms',
        }
        return units.get(setting_name, '')

    def get_setting_category(self, setting_name: str) -> str:
        """Get the category for a PostgreSQL setting."""
        categories = {
            'max_connections': 'Connections and Authentication',
            'shared_buffers': 'Memory',
            'effective_cache_size': 'Memory',
            'work_mem': 'Memory',
            'maintenance_work_mem': 'Memory',
            'checkpoint_completion_target': 'Write-Ahead Logging',
            'wal_buffers': 'Write-Ahead Logging',
            'default_statistics_target': 'Query Planning',
            'random_page_cost': 'Query Planning',
            'effective_io_concurrency': 'Asynchronous Behavior',
            'autovacuum_max_workers': 'Autovacuum',
            'autovacuum_naptime': 'Autovacuum',
            'log_min_duration_statement': 'Logging',
            'idle_in_transaction_session_timeout': 'Client Connection Defaults',
            'lock_timeout': 'Client Connection Defaults',
            'statement_timeout': 'Client Connection Defaults',
        }
        return categories.get(setting_name, 'Other')

    def format_setting_value(self, setting_name: str, value: str, unit: str = "") -> str:
        """Format a setting value for display."""
        try:
            # If we have a unit from the metric, use it
            if unit:
                if unit == "8kB":
                    val = int(value) * 8
                    if val >= 1024 and val % 1024 == 0:
                        return f"{val // 1024} MB"
                    else:
                        return f"{val} kB"
                elif unit == "ms":
                    val = int(value)
                    if val >= 1000 and val % 1000 == 0:
                        return f"{val // 1000} s"
                    else:
                        return f"{val} ms"
                elif unit == "s":
                    return f"{value} s"
                elif unit == "min":
                    return f"{value} min"
                elif unit == "connections":
                    return f"{value} connections"
                elif unit == "workers":
                    return f"{value} workers"
                else:
                    return f"{value} {unit}"

            # Fallback to setting name based formatting
            if setting_name in ['shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem',
                                'autovacuum_work_mem', 'logical_decoding_work_mem', 'temp_buffers', 'wal_buffers']:
                val = int(value)
                if val >= 1024:
                    return f"{val // 1024} MB"
                else:
                    return f"{val} kB"
            elif setting_name in ['log_min_duration_statement', 'idle_in_transaction_session_timeout', 'lock_timeout',
                                  'statement_timeout', 'autovacuum_vacuum_cost_delay', 'vacuum_cost_delay']:
                val = int(value)
                if val >= 1000:
                    return f"{val // 1000} s"
                else:
                    return f"{val} ms"
            elif setting_name in ['autovacuum_naptime']:
                val = int(value)
                if val >= 60:
                    return f"{val // 60} min"
                else:
                    return f"{val} s"
            elif setting_name in ['autovacuum_max_workers']:
                return f"{value} workers"
            elif setting_name in ['pg_stat_statements.max']:
                return f"{value} statements"
            elif setting_name in ['max_wal_size', 'min_wal_size']:
                val = int(value)
                if val >= 1024:
                    return f"{val // 1024} GB"
                else:
                    return f"{val} MB"
            elif setting_name in ['checkpoint_completion_target']:
                return f"{float(value):.2f}"
            elif setting_name in ['hash_mem_multiplier']:
                return f"{float(value):.1f}"
            elif setting_name in ['max_connections', 'max_prepared_transactions', 'max_locks_per_transaction',
                                  'max_pred_locks_per_transaction', 'max_pred_locks_per_relation',
                                  'max_pred_locks_per_page', 'max_files_per_process']:
                return f"{value} connections" if "connections" in setting_name else f"{value}"
            elif setting_name in ['max_stack_depth']:
                val = int(value)
                if val >= 1024:
                    return f"{val // 1024} MB"
                else:
                    return f"{val} kB"
            elif setting_name in ['autovacuum_analyze_scale_factor', 'autovacuum_vacuum_scale_factor',
                                  'autovacuum_vacuum_insert_scale_factor']:
                return f"{float(value) * 100:.1f}%"
            elif setting_name in ['autovacuum', 'track_activities', 'track_counts', 'track_functions',
                                  'track_io_timing', 'track_wal_io_timing', 'pg_stat_statements.track_utility',
                                  'pg_stat_statements.save', 'pg_stat_statements.track_planning']:
                return "on" if value.lower() in ['on', 'true', '1'] else "off"
            elif setting_name in ['huge_pages']:
                return value  # on/off/try
            else:
                return str(value)
        except (ValueError, TypeError):
            return str(value)

    def get_cluster_metric_unit(self, metric_name: str) -> str:
        """Get the unit for a cluster metric."""
        units = {
            'active_connections': 'connections',
            'idle_connections': 'connections',
            'total_connections': 'connections',
            'database_size': 'bytes',
            'cache_hit_ratio': '%',
            'transactions_per_sec': 'tps',
            'checkpoints_per_sec': 'checkpoints/s',
            'deadlocks': 'count',
            'temp_files': 'files',
            'temp_bytes': 'bytes',
        }
        return units.get(metric_name, '')

    def get_cluster_metric_description(self, metric_name: str) -> str:
        """Get the description for a cluster metric."""
        descriptions = {
            'active_connections': 'Number of active connections',
            'idle_connections': 'Number of idle connections',
            'total_connections': 'Total number of connections',
            'database_size': 'Total database size in bytes',
            'cache_hit_ratio': 'Cache hit ratio percentage',
            'transactions_per_sec': 'Transactions per second',
            'checkpoints_per_sec': 'Checkpoints per second',
            'deadlocks': 'Number of deadlocks',
            'temp_files': 'Number of temporary files',
            'temp_bytes': 'Size of temporary files in bytes',
        }
        return descriptions.get(metric_name, '')

    def generate_all_reports(self, cluster: str = "local", node_name: str = None, combine_nodes: bool = True) -> Dict[str, Any]:
        """
        Generate all reports.
        
        Args:
            cluster: Cluster name
            node_name: Node name (if None and combine_nodes=True, will query all nodes)
            combine_nodes: If True, combine primary and replica reports into single report
            
        Returns:
            Dictionary containing all reports
        """
        reports = {}

        # Determine which nodes to process
        if combine_nodes and node_name is None:
            # Get all nodes and combine them
            all_nodes = self.get_all_nodes(cluster)
            nodes_to_process = []
            if all_nodes["primary"]:
                nodes_to_process.append(all_nodes["primary"])
            nodes_to_process.extend(all_nodes["standbys"])
            
            # If no nodes found, fall back to default
            if not nodes_to_process:
                print(f"Warning: No nodes found in cluster '{cluster}', using default 'node-01'")
                nodes_to_process = ["node-01"]
                all_nodes = {"primary": "node-01", "standbys": []}
            else:
                print(f"Combining reports from nodes: {nodes_to_process}")
        else:
            # Use single node (backward compatibility)
            if node_name is None:
                node_name = "node-01"
            nodes_to_process = [node_name]
            all_nodes = {"primary": node_name, "standbys": []}

        # Generate each report type
        report_types = [
            ('A002', self.generate_a002_version_report),
            ('A003', self.generate_a003_settings_report),
            ('A004', self.generate_a004_cluster_report),
            ('A007', self.generate_a007_altered_settings_report),
            ('D004', self.generate_d004_pgstat_settings_report),
            ('F001', self.generate_f001_autovacuum_settings_report),
            ('F004', self.generate_f004_heap_bloat_report),
            ('F005', self.generate_f005_btree_bloat_report),
            ('G001', self.generate_g001_memory_settings_report),
            ('H001', self.generate_h001_invalid_indexes_report),
            ('H002', self.generate_h002_unused_indexes_report),
            ('H004', self.generate_h004_redundant_indexes_report),
            ('K001', self.generate_k001_query_calls_report),
            ('K003', self.generate_k003_top_queries_report),
            ('M001', self.generate_m001_mean_time_report),
            ('M002', self.generate_m002_rows_report),
            ('M003', self.generate_m003_io_time_report),
            ('N001', self.generate_n001_wait_events_report),
        ]

        for check_id, report_func in report_types:
            if len(nodes_to_process) == 1:
                # Single node - generate report normally
                reports[check_id] = report_func(cluster, nodes_to_process[0])
            else:
                # Multiple nodes - combine reports
                combined_results = {}
                for node in nodes_to_process:
                    print(f"Generating {check_id} report for node {node}...")
                    node_report = report_func(cluster, node)
                    # Extract the data from the node report
                    if 'results' in node_report and node in node_report['results']:
                        combined_results[node] = node_report['results'][node]
                
                # Create combined report with all nodes
                reports[check_id] = self.format_report_data(
                    check_id, 
                    combined_results, 
                    all_nodes["primary"] if all_nodes["primary"] else nodes_to_process[0],
                    all_nodes
                )

        return reports

    def get_all_clusters(self) -> List[str]:
        """
        Get all unique cluster names (projects) from the metrics.
        
        Returns:
            List of cluster names
        """
        # Query for all clusters using last_over_time to get recent values
        clusters_query = 'last_over_time(pgwatch_settings_configured[3h])'
        result = self.query_instant(clusters_query)
        
        cluster_set = set()
        
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                cluster_name = item['metric'].get('cluster', '')
                if cluster_name:
                    cluster_set.add(cluster_name)
        else:
            # Debug output
            print(f"Debug - get_all_clusters query status: {result.get('status')}")
            print(f"Debug - get_all_clusters result count: {len(result.get('data', {}).get('result', []))}")
        
        if cluster_set:
            print(f"Found {len(cluster_set)} cluster(s): {sorted(list(cluster_set))}")
        
        return sorted(list(cluster_set))

    def get_all_nodes(self, cluster: str = "local") -> Dict[str, List[str]]:
        """
        Get all nodes (primary and replicas) from the metrics.
        Uses pgwatch_db_stats_in_recovery_int to determine primary vs standby.
        
        Args:
            cluster: Cluster name
            
        Returns:
            Dictionary with 'primary' and 'standbys' keys containing node names
        """
        # Query for all nodes in the cluster using last_over_time
        nodes_query = f'last_over_time(pgwatch_settings_configured{{cluster="{cluster}"}}[3h])'
        result = self.query_instant(nodes_query)
        
        nodes = {"primary": None, "standbys": []}
        node_set = set()
        
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                node_name = item['metric'].get('node_name', '')
                if node_name and node_name not in node_set:
                    node_set.add(node_name)
        
        # Convert to sorted list
        node_list = sorted(list(node_set))
        
        if node_list:
            print(f"  Found {len(node_list)} node(s) in cluster '{cluster}': {node_list}")
        else:
            print(f"  Warning: No nodes found in cluster '{cluster}'")
        
        # Use pgwatch_db_stats_in_recovery_int to determine primary vs standby
        # in_recovery = 0 means primary, in_recovery = 1 means standby
        for node_name in node_list:
            recovery_query = f'last_over_time(pgwatch_db_stats_in_recovery_int{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
            recovery_result = self.query_instant(recovery_query)
            
            is_standby = False
            if recovery_result.get('status') == 'success' and recovery_result.get('data', {}).get('result'):
                if recovery_result['data']['result']:
                    in_recovery_value = float(recovery_result['data']['result'][0]['value'][1])
                    is_standby = (in_recovery_value > 0)
                    print(f"  Node '{node_name}': in_recovery={int(in_recovery_value)} ({'standby' if is_standby else 'primary'})")
            
            if is_standby:
                nodes["standbys"].append(node_name)
            else:
                # First non-standby node becomes primary
                if nodes["primary"] is None:
                    nodes["primary"] = node_name
                else:
                    # If we have multiple primaries (shouldn't happen), treat as replicas
                    print(f"  Warning: Multiple primary nodes detected, treating '{node_name}' as replica")
                    nodes["standbys"].append(node_name)
        
        print(f"  Result: primary={nodes['primary']}, replicas={nodes['standbys']}")
        return nodes

    def get_all_databases(self, cluster: str = "local", node_name: str = "node-01") -> List[str]:
        """
        Get all databases from the metrics.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            List of database names
        """
        # Build a source-agnostic database list by unifying labels from:
        # 1) Generic per-database metric (wraparound) → datname
        # 2) Custom index reports (unused/redundant) → dbname
        # 3) Btree bloat (for completeness) → datname
        databases: List[str] = []
        database_set = set()

        # Helper to add a name safely
        def add_db(name: str) -> None:
            if name and name not in self.excluded_databases and name not in database_set:
                database_set.add(name)
                databases.append(name)

        # 1) Generic per-database metric
        wrap_q = f'last_over_time(pgwatch_pg_database_wraparound_age_datfrozenxid{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        wrap_res = self.query_instant(wrap_q)
        if wrap_res.get('status') == 'success' and wrap_res.get('data', {}).get('result'):
            for item in wrap_res['data']['result']:
                add_db(item["metric"].get("datname", ""))

        # 2) Custom reports using dbname
        unused_q = f'last_over_time(pgwatch_unused_indexes_index_size_bytes{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        redun_q = f'last_over_time(pgwatch_redundant_indexes_index_size_bytes{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        for q in (unused_q, redun_q):
            res = self.query_instant(q)
            if res.get('status') == 'success' and res.get('data', {}).get('result'):
                for item in res['data']['result']:
                    add_db(item["metric"].get("dbname", ""))

        # 3) Btree bloat family
        bloat_q = f'last_over_time(pgwatch_pg_btree_bloat_bloat_pct{{cluster="{cluster}", node_name="{node_name}"}}[3h])'
        bloat_res = self.query_instant(bloat_q)
        if bloat_res.get('status') == 'success' and bloat_res.get('data', {}).get('result'):
            for item in bloat_res['data']['result']:
                add_db(item["metric"].get("datname", ""))

        return databases

    def _get_pgss_metrics_data_by_db(self, cluster: str, node_name: str, db_name: str, start_time: datetime,
                                     end_time: datetime) -> List[Dict[str, Any]]:
        """
        Get pg_stat_statements metrics data for a specific database between two time points.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            db_name: Database name
            start_time: Start datetime
            end_time: End datetime
            
        Returns:
            List of query metrics with calculated differences for the specific database
        """
        # Metric name mapping for cleaner output
        METRIC_NAME_MAPPING = {
            'calls': 'calls',
            'exec_time_total': 'total_time',
            'rows': 'rows',
            'shared_bytes_hit_total': 'shared_blks_hit',
            'shared_bytes_read_total': 'shared_blks_read',
            'shared_bytes_dirtied_total': 'shared_blks_dirtied',
            'shared_bytes_written_total': 'shared_blks_written',
            'block_read_total': 'blk_read_time',
            'block_write_total': 'blk_write_time'
        }

        # Build filters including database
        filters = [f'cluster="{cluster}"', f'node_name="{node_name}"', f'datname="{db_name}"']
        filter_str = '{' + ','.join(filters) + '}'

        # Get all pg_stat_statements metrics
        all_metrics = [
            'pgwatch_pg_stat_statements_calls',
            'pgwatch_pg_stat_statements_exec_time_total',
            'pgwatch_pg_stat_statements_rows',
            'pgwatch_pg_stat_statements_shared_bytes_hit_total',
            'pgwatch_pg_stat_statements_shared_bytes_read_total',
            'pgwatch_pg_stat_statements_shared_bytes_dirtied_total',
            'pgwatch_pg_stat_statements_shared_bytes_written_total',
            'pgwatch_pg_stat_statements_block_read_total',
            'pgwatch_pg_stat_statements_block_write_total'
        ]

        # Get metrics at start and end times
        start_data = []
        end_data = []
        
        metrics_found = 0

        for metric in all_metrics:
            metric_with_filters = f'{metric}{filter_str}'

            try:
                # Query metrics around start time - use instant queries at specific timestamps
                start_result = self.query_range(metric_with_filters, start_time - timedelta(minutes=1),
                                                start_time + timedelta(minutes=1))
                if start_result:
                    start_data.extend(start_result)
                    metrics_found += 1

                # Query metrics around end time  
                end_result = self.query_range(metric_with_filters, end_time - timedelta(minutes=1),
                                              end_time + timedelta(minutes=1))
                if end_result:
                    end_data.extend(end_result)

            except Exception as e:
                print(f"Warning: Failed to query metric {metric} for database {db_name}: {e}")
                continue
        
        if metrics_found == 0:
            print(f"Warning: No pg_stat_statements metrics found for database {db_name}")
            print(f"  Checked time range: {start_time.isoformat()} to {end_time.isoformat()}")

        # Process the data to calculate differences
        result = self._process_pgss_data(start_data, end_data, start_time, end_time, METRIC_NAME_MAPPING)
        
        if not result:
            print(f"Warning: _process_pgss_data returned empty result for database {db_name}")
            
        return result

    def create_report(self, api_url, token, project_name, epoch):
        """
        Create a new report in the API.
        
        Args:
            api_url: API URL
            token: API token
            project_name: Project name (cluster identifier)
            epoch: Epoch identifier
            
        Returns:
            Report ID
        """
        request_data = {
            "access_token": token,
            "project": project_name,
            "epoch": epoch,
        }

        response = make_request(api_url, "/rpc/checkup_report_create", request_data)
        report_id = response.get("report_id")
        if not report_id:
            message = response.get("message", "Cannot create report.")
            raise Exception(message)

        return int(report_id)

    def upload_report_file(self, api_url, token, report_id, path):
        file_type = os.path.splitext(path)[1].lower().lstrip(".")
        file_name = os.path.basename(path)
        check_id = file_name[:4] if file_name[4:5] == "_" else ""

        with open(path, "r") as f:
            data = f.read()

        request_data = {
            "access_token": token,
            "checkup_report_id": report_id,
            "check_id": check_id,
            "filename": file_name,
            "data": data,
            "type": file_type,
            "generate_issue": True
        }

        response = make_request(api_url, "/rpc/checkup_report_file_post", request_data)
        if "message" in response:
            raise Exception(response["message"])


def make_request(api_url, endpoint, request_data):
    response = requests.post(api_url + endpoint, json=request_data)
    response.raise_for_status()
    return response.json()


def main():
    parser = argparse.ArgumentParser(description='Generate PostgreSQL reports using PromQL')
    parser.add_argument('--version', action='version', version=f'%(prog)s {__version__}')
    parser.add_argument('--prometheus-url', default='http://sink-prometheus:9090',
                        help='Prometheus URL (default: http://sink-prometheus:9090)')
    parser.add_argument('--postgres-sink-url', default='postgresql://pgwatch@sink-postgres:5432/measurements',
                        help='Postgres sink connection string (default: postgresql://pgwatch@sink-postgres:5432/measurements)')
    parser.add_argument('--cluster', default=None,
                        help='Cluster name (default: auto-detect all clusters)')
    parser.add_argument('--node-name', default=None,
                        help='Node name (default: auto-detect all nodes when combine-nodes is true)')
    parser.add_argument('--no-combine-nodes', action='store_true', default=False,
                        help='Disable combining primary and replica reports into single report')
    parser.add_argument('--check-id',
                        choices=['A002', 'A003', 'A004', 'A007', 'D004', 'F001', 'F004', 'F005', 'G001', 'H001', 'H002',
                                 'H004', 'K001', 'K003', 'M001', 'M002', 'M003', 'N001', 'ALL'],
                        help='Specific check ID to generate (default: ALL)')
    parser.add_argument('--output', default='-',
                        help='Output file (default: stdout)')
    parser.add_argument('--api-url', default='https://postgres.ai/api/general')
    parser.add_argument('--token', default='')
    parser.add_argument('--project-name', default='project-name',
                        help='Project name for API upload (default: project-name)')
    parser.add_argument('--epoch', default='1')
    parser.add_argument('--no-upload', action='store_true', default=False,
                        help='Do not upload reports to the API')
    parser.add_argument('--exclude-databases', type=str, default=None,
                        help='Comma-separated list of additional databases to exclude from reports '
                             f'(default exclusions: {", ".join(sorted(PostgresReportGenerator.DEFAULT_EXCLUDED_DATABASES))})')

    args = parser.parse_args()
    
    # Parse excluded databases
    excluded_databases = None
    if args.exclude_databases:
        excluded_databases = [db.strip() for db in args.exclude_databases.split(',')]

    generator = PostgresReportGenerator(args.prometheus_url, args.postgres_sink_url, excluded_databases)

    # Test connection
    if not generator.test_connection():
        print("Error: Cannot connect to Prometheus. Make sure it's running and accessible.")
        sys.exit(1)

    try:
        # Discover all clusters if not specified
        clusters_to_process = []
        if args.cluster:
            clusters_to_process = [args.cluster]
        else:
            clusters_to_process = generator.get_all_clusters()
            if not clusters_to_process:
                print("Warning: No clusters found, using default 'local'")
                clusters_to_process = ['local']
            else:
                print(f"Discovered clusters: {clusters_to_process}")
        
        # Process each cluster
        for cluster in clusters_to_process:
            print(f"\n{'='*60}")
            print(f"Processing cluster: {cluster}")
            print(f"{'='*60}\n")
            
            # Set default node_name if not provided and not combining nodes
            combine_nodes = not args.no_combine_nodes
            if args.node_name is None and not combine_nodes:
                args.node_name = "node-01"
                
            if args.check_id == 'ALL' or args.check_id is None:
                # Generate all reports for this cluster
                if not args.no_upload:
                    # Use cluster name as project name if not specified
                    project_name = args.project_name if args.project_name != 'project-name' else cluster
                    report_id = generator.create_report(args.api_url, args.token, project_name, args.epoch)
                
                reports = generator.generate_all_reports(cluster, args.node_name, combine_nodes)
                
                # Save reports with cluster name prefix
                for report in reports:
                    output_filename = f"{cluster}_{report}.json" if len(clusters_to_process) > 1 else f"{report}.json"
                    with open(output_filename, "w") as f:
                        json.dump(reports[report], f, indent=2)
                    print(f"Generated report: {output_filename}")
                    if not args.no_upload:
                        generator.upload_report_file(args.api_url, args.token, report_id, output_filename)
                
                if args.output == '-':
                    pass
                elif len(clusters_to_process) == 1:
                    # Single cluster - use specified output
                    with open(args.output, 'w') as f:
                        json.dump(reports, f, indent=2)
                    print(f"All reports written to {args.output}")
                else:
                    # Multiple clusters - create combined output
                    combined_output = f"{cluster}_all_reports.json"
                    with open(combined_output, 'w') as f:
                        json.dump(reports, f, indent=2)
                    print(f"All reports for cluster {cluster} written to {combined_output}")
            else:
                # Generate specific report - use node_name or default
                if args.node_name is None:
                    args.node_name = "node-01"
                    
                if args.check_id == 'A002':
                    report = generator.generate_a002_version_report(cluster, args.node_name)
                elif args.check_id == 'A003':
                    report = generator.generate_a003_settings_report(cluster, args.node_name)
                elif args.check_id == 'A004':
                    report = generator.generate_a004_cluster_report(cluster, args.node_name)
                elif args.check_id == 'A007':
                    report = generator.generate_a007_altered_settings_report(cluster, args.node_name)
                elif args.check_id == 'D004':
                    report = generator.generate_d004_pgstat_settings_report(cluster, args.node_name)
                elif args.check_id == 'F001':
                    report = generator.generate_f001_autovacuum_settings_report(cluster, args.node_name)
                elif args.check_id == 'F004':
                    report = generator.generate_f004_heap_bloat_report(cluster, args.node_name)
                elif args.check_id == 'F005':
                    report = generator.generate_f005_btree_bloat_report(cluster, args.node_name)
                elif args.check_id == 'G001':
                    report = generator.generate_g001_memory_settings_report(cluster, args.node_name)
                elif args.check_id == 'H001':
                    report = generator.generate_h001_invalid_indexes_report(cluster, args.node_name)
                elif args.check_id == 'H002':
                    report = generator.generate_h002_unused_indexes_report(cluster, args.node_name)
                elif args.check_id == 'H004':
                    report = generator.generate_h004_redundant_indexes_report(cluster, args.node_name)
                elif args.check_id == 'K001':
                    report = generator.generate_k001_query_calls_report(cluster, args.node_name)
                elif args.check_id == 'K003':
                    report = generator.generate_k003_top_queries_report(cluster, args.node_name)
                elif args.check_id == 'M001':
                    report = generator.generate_m001_mean_time_report(cluster, args.node_name)
                elif args.check_id == 'M002':
                    report = generator.generate_m002_rows_report(cluster, args.node_name)
                elif args.check_id == 'M003':
                    report = generator.generate_m003_io_time_report(cluster, args.node_name)
                elif args.check_id == 'N001':
                    report = generator.generate_n001_wait_events_report(cluster, args.node_name)

                output_filename = f"{cluster}_{args.check_id}.json" if len(clusters_to_process) > 1 else args.output
                
                if args.output == '-' and len(clusters_to_process) == 1:
                    print(json.dumps(report, indent=2))
                else:
                    with open(output_filename, 'w') as f:
                        json.dump(report, f, indent=2)
                    print(f"Report written to {output_filename}")
                    if not args.no_upload:
                        project_name = args.project_name if args.project_name != 'project-name' else cluster
                        report_id = generator.create_report(args.api_url, args.token, project_name, args.epoch)
                        generator.upload_report_file(args.api_url, args.token, report_id, output_filename)
    except Exception as e:
        print(f"Error generating reports: {e}")
        raise e
        sys.exit(1)
    finally:
        # Clean up postgres connection
        generator.close_postgres_sink()


if __name__ == "__main__":
    main()
