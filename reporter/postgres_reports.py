#!/usr/bin/env python3
"""
PostgreSQL Reports Generator using PromQL

This script generates reports for specific PostgreSQL check types (A002, A003, A004, A007, D004, F001, F004, F005, H001, H002, H004, K001, K003)
by querying Prometheus metrics using PromQL queries.
"""

import requests
import json
import time
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
import argparse
import sys
import os


class PostgresReportGenerator:
    def __init__(self, prometheus_url: str = "http://localhost:9090"):
        """
        Initialize the PostgreSQL report generator.
        
        Args:
            prometheus_url: URL of the Prometheus instance
        """
        self.prometheus_url = prometheus_url
        self.base_url = f"{prometheus_url}/api/v1"

    def test_connection(self) -> bool:
        """Test connection to Prometheus."""
        try:
            response = requests.get(f"{self.base_url}/status/config", timeout=10)
            return response.status_code == 200
        except Exception as e:
            print(f"Connection failed: {e}")
            return False

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

    def generate_a002_version_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
        """
        Generate A002 Version Information report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing version information
        """
        print("Generating A002 Version Information report...")
        settings_query = f'pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}"}}'
        # Query PostgreSQL version information

        version_queries = {
            'server_version': f'pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}", setting_name="server_version"}}',
            'server_version_num': f'pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}", setting_name="server_version_num"}}',
            'max_connections': f'pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}", setting_name="max_connections"}}',
            'shared_buffers': f'pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}", setting_name="shared_buffers"}}',
            'effective_cache_size': f'pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}", setting_name="effective_cache_size"}}',
        }

        version_data = {}
        for metric_name, query in version_queries.items():
            result = self.query_instant(query)
            if result.get('status') == 'success' and result.get('data', {}).get('result'):
                latest_value = result['data']['result'][0]['metric'].get('setting_value', None)
                version_data[metric_name] = latest_value

        # Format the version data
        version_info = {
            "version": version_data.get('server_version', 'Unknown'),
            "server_version_num": version_data.get('server_version_num', 'Unknown'),
            "server_major_ver": version_data.get('server_version', '').split('.')[0] if version_data.get(
                'server_version') else 'Unknown',
            "server_minor_ver": version_data.get('server_version', '').split('.', 1)[1] if version_data.get(
                'server_version') and '.' in version_data.get('server_version', '') else 'Unknown'
        }

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

        # Query all PostgreSQL settings using the pgwatch_settings_setting metric
        # This metric has labels for each setting name
        settings_query = f'pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}"}}'
        result = self.query_instant(settings_query)

        settings_data = {}
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                # Extract setting name from labels
                setting_name = item['metric'].get('setting_name', 'unknown')
                setting_value = item['metric'].get('setting_value', '')

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

        return self.format_report_data("A003", settings_data, node_name)

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
            'active_connections': f'sum(pgwatch_pg_stat_activity_count{{cluster="{cluster}", node_name="{node_name}", state="active"}})',
            'idle_connections': f'sum(pgwatch_pg_stat_activity_count{{cluster="{cluster}", node_name="{node_name}", state="idle"}})',
            'total_connections': f'sum(pgwatch_pg_stat_activity_count{{cluster="{cluster}", node_name="{node_name}"}})',
            'database_size': f'sum(pgwatch_pg_database_size_bytes{{cluster="{cluster}", node_name="{node_name}"}})',
            'cache_hit_ratio': f'sum(pgwatch_db_stats_blks_hit{{cluster="{cluster}", node_name="{node_name}"}}) / (sum(pgwatch_db_stats_blks_hit{{cluster="{cluster}", node_name="{node_name}"}}) + sum(pgwatch_db_stats_blks_read{{cluster="{cluster}", node_name="{node_name}"}})) * 100',
            'transactions_per_sec': f'sum(rate(pgwatch_db_stats_xact_commit{{cluster="{cluster}", node_name="{node_name}"}}[5m])) + sum(rate(pgwatch_db_stats_xact_rollback{{cluster="{cluster}", node_name="{node_name}"}}[5m]))',
            'checkpoints_per_sec': f'sum(rate(pgwatch_pg_stat_bgwriter_checkpoints_timed{{cluster="{cluster}", node_name="{node_name}"}}[5m])) + sum(rate(pgwatch_pg_stat_bgwriter_checkpoints_req{{cluster="{cluster}", node_name="{node_name}"}}[5m]))',
            'deadlocks': f'sum(pgwatch_db_stats_deadlocks{{cluster="{cluster}", node_name="{node_name}"}})',
            'temp_files': f'sum(pgwatch_db_stats_temp_files{{cluster="{cluster}", node_name="{node_name}"}})',
            'temp_bytes': f'sum(pgwatch_db_stats_temp_bytes{{cluster="{cluster}", node_name="{node_name}"}})',
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
        db_sizes_query = f'pgwatch_pg_database_size_bytes{{cluster="{cluster}", node_name="{node_name}"}}'
        db_sizes_result = self.query_instant(db_sizes_query)
        database_sizes = {}

        if db_sizes_result.get('status') == 'success' and db_sizes_result.get('data', {}).get('result'):
            for result in db_sizes_result['data']['result']:
                db_name = result['metric'].get('datname', 'unknown')
                size_bytes = float(result['value'][1])
                database_sizes[db_name] = size_bytes

        return self.format_report_data("A004", {
            "general_info": cluster_data,
            "database_sizes": database_sizes
        }, node_name)

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

        # Query settings by source using the pgwatch_settings_setting metric
        settings_by_source_query = f'pgwatch_settings_is_default{{cluster="{cluster}", node_name="{node_name}"}} < 1'
        result = self.query_instant(settings_by_source_query)

        settings_count = {}
        changes = []

        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            # Group settings by source
            altered_settings = {}
            for item in result['data']['result']:
                # Extract source from labels
                setting_name = item['metric'].get('setting_name', 'unknown')
                value = item['metric'].get('setting_value', 'unknown')
                unit = item['metric'].get('unit', '')
                category = item['metric'].get('category', 'unknown')
                pretty_value = self.format_setting_value(setting_name, value, unit)
                altered_settings[setting_name] = {
                    "value": value,
                    "unit": unit,
                    "category": category,
                    "pretty_value": pretty_value
                }

            return self.format_report_data("A007", altered_settings, node_name)

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

        invalid_indexes_by_db = {}
        for db_name in databases:
            # Query invalid indexes for each database
            invalid_indexes_query = f'pgwatch_pg_invalid_indexes{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}'
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

            invalid_indexes_by_db[db_name] = {
                "invalid_indexes": invalid_indexes,
                "total_count": len(invalid_indexes),
                "total_size_bytes": total_size,
                "total_size_pretty": self.format_bytes(total_size)
            }

        return self.format_report_data("H001", invalid_indexes_by_db, node_name)

    def generate_h002_unused_indexes_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
        """
        Generate H002 Unused and rarely used Indexes report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing unused and rarely used indexes information
        """
        print("Generating H002 Unused and rarely used Indexes report...")

        # Get all databases
        databases = self.get_all_databases(cluster, node_name)

        unused_indexes_by_db = {}
        for db_name in databases:
            # Query unused indexes for each database
            unused_indexes_query = f'pgwatch_unused_indexes_index_size_bytes{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}'
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
                    idx_scan_query = f'pgwatch_unused_indexes_idx_scan{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}", schema_name="{schema_name}", table_name="{table_name}", index_name="{index_name}"}}'
                    idx_scan_result = self.query_instant(idx_scan_query)
                    idx_scan = float(idx_scan_result['data']['result'][0]['value'][1]) if idx_scan_result.get('data',
                                                                                                              {}).get(
                        'result') else 0

                    index_data = {
                        "schema_name": schema_name,
                        "table_name": table_name,
                        "index_name": index_name,
                        "reason": reason,
                        "idx_scan": idx_scan,
                        "index_size_bytes": index_size_bytes,
                        "idx_is_btree": item['metric'].get('opclasses', '').startswith('btree'),
                        "supports_fk": bool(int(item['metric'].get('supports_fk', 0)))
                    }

                    index_data['index_size_pretty'] = self.format_bytes(index_data['index_size_bytes'])

                    unused_indexes.append(index_data)

            # Query rarely used indexes (note: logs show 0 rows, but we'll include the structure)
            rarely_used_indexes = []  # Currently empty as per logs

            # Combine and calculate totals
            all_indexes = unused_indexes + rarely_used_indexes
            total_unused_size = sum(idx['index_size_bytes'] for idx in unused_indexes)
            total_rarely_used_size = sum(idx['index_size_bytes'] for idx in rarely_used_indexes)
            total_size = total_unused_size + total_rarely_used_size

            # Sort by index size descending
            all_indexes.sort(key=lambda x: x['index_size_bytes'], reverse=True)

            unused_indexes_by_db[db_name] = {
                "unused_indexes": unused_indexes,
                "rarely_used_indexes": rarely_used_indexes,
                "all_indexes": all_indexes,
                "summary": {
                    "total_unused_count": len(unused_indexes),
                    "total_rarely_used_count": len(rarely_used_indexes),
                    "total_count": len(all_indexes),
                    "total_unused_size_bytes": total_unused_size,
                    "total_rarely_used_size_bytes": total_rarely_used_size,
                    "total_size_bytes": total_size,
                    "total_unused_size_pretty": self.format_bytes(total_unused_size),
                    "total_rarely_used_size_pretty": self.format_bytes(total_rarely_used_size),
                    "total_size_pretty": self.format_bytes(total_size)
                }
            }

        return self.format_report_data("H002", unused_indexes_by_db, node_name)

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

        redundant_indexes_by_db = {}
        for db_name in databases:
            # Query redundant indexes for each database
            redundant_indexes_query = f'pgwatch_redundant_indexes_index_size_bytes{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}'
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
                    table_size_query = f'pgwatch_redundant_indexes_table_size_bytes{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}", schema_name="{schema_name}", table_name="{table_name}", index_name="{index_name}"}}'
                    table_size_result = self.query_instant(table_size_query)
                    table_size_bytes = float(
                        table_size_result['data']['result'][0]['value'][1]) if table_size_result.get('data', {}).get(
                        'result') else 0

                    index_usage_query = f'pgwatch_redundant_indexes_index_usage{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}", schema_name="{schema_name}", table_name="{table_name}", index_name="{index_name}"}}'
                    index_usage_result = self.query_instant(index_usage_query)
                    index_usage = float(index_usage_result['data']['result'][0]['value'][1]) if index_usage_result.get(
                        'data', {}).get('result') else 0

                    supports_fk_query = f'pgwatch_redundant_indexes_supports_fk{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}", schema_name="{schema_name}", table_name="{table_name}", index_name="{index_name}"}}'
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
                        "index_size_pretty": self.format_bytes(index_size_bytes),
                        "table_size_pretty": self.format_bytes(table_size_bytes)
                    }

                    redundant_indexes.append(redundant_index)
                    total_size += index_size_bytes

            # Sort by index size descending
            redundant_indexes.sort(key=lambda x: x['index_size_bytes'], reverse=True)

            redundant_indexes_by_db[db_name] = {
                "redundant_indexes": redundant_indexes,
                "total_count": len(redundant_indexes),
                "total_size_bytes": total_size,
                "total_size_pretty": self.format_bytes(total_size)
            }

        return self.format_report_data("H004", redundant_indexes_by_db, node_name)

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

        # Query all PostgreSQL settings for pg_stat_statements and related
        settings_query = f'pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}"}}'
        result = self.query_instant(settings_query)

        pgstat_data = {}
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                setting_name = item['metric'].get('setting_name', 'unknown')

                # Filter for pg_stat_statements and related settings
                if any(pgstat_setting in setting_name for pgstat_setting in pgstat_settings):
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

        # Check if pg_stat_kcache extension is available and working by querying its metrics
        kcache_status = self._check_pg_stat_kcache_status(cluster, node_name)

        # Check if pg_stat_statements is available and working by querying its metrics  
        pgss_status = self._check_pg_stat_statements_status(cluster, node_name)

        return self.format_report_data("D004", {
            "settings": pgstat_data,
            "pg_stat_statements_status": pgss_status,
            "pg_stat_kcache_status": kcache_status
        }, node_name)

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
            'exec_user_time': f'pgwatch_pg_stat_kcache_exec_user_time{{cluster="{cluster}", node_name="{node_name}"}}',
            'exec_system_time': f'pgwatch_pg_stat_kcache_exec_system_time{{cluster="{cluster}", node_name="{node_name}"}}',
            'exec_total_time': f'pgwatch_pg_stat_kcache_exec_total_time{{cluster="{cluster}", node_name="{node_name}"}}'
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
        pgss_query = f'pgwatch_pg_stat_statements_calls{{cluster="{cluster}", node_name="{node_name}"}}'
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

        # Query all PostgreSQL settings for autovacuum
        settings_query = f'pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}"}}'
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

        return self.format_report_data("F001", autovacuum_data, node_name)

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

        bloated_indexes_by_db = {}
        for db_name in databases:
            # Query btree bloat using multiple metrics for each database
            bloat_queries = {
                'extra_size': f'pgwatch_pg_btree_bloat_extra_size{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}',
                'extra_pct': f'pgwatch_pg_btree_bloat_extra_pct{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}',
                'bloat_size': f'pgwatch_pg_btree_bloat_bloat_size{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}',
                'bloat_pct': f'pgwatch_pg_btree_bloat_bloat_pct{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}',
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
                # Skip indexes with minimal bloat
                if index_data['bloat_pct'] >= 10:  # Only report indexes with >= 10% bloat
                    index_data['extra_size_pretty'] = self.format_bytes(index_data['extra_size'])
                    index_data['bloat_size_pretty'] = self.format_bytes(index_data['bloat_size'])

                    bloated_indexes_list.append(index_data)
                    total_bloat_size += index_data['bloat_size']

            # Sort by bloat percentage descending
            bloated_indexes_list.sort(key=lambda x: x['bloat_pct'], reverse=True)

            bloated_indexes_by_db[db_name] = {
                "bloated_indexes": bloated_indexes_list,
                "total_count": len(bloated_indexes_list),
                "total_bloat_size_bytes": total_bloat_size,
                "total_bloat_size_pretty": self.format_bytes(total_bloat_size)
            }

        return self.format_report_data("F005", bloated_indexes_by_db, node_name)

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

        # Query all PostgreSQL settings for memory-related settings
        settings_query = f'pgwatch_settings_configured{{cluster="{cluster}", node_name="{node_name}"}}'
        result = self.query_instant(settings_query)

        memory_data = {}
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                setting_name = item['metric'].get('setting_name', 'unknown')

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

        # Calculate some memory usage estimates and recommendations
        memory_analysis = self._analyze_memory_settings(memory_data)

        return self.format_report_data("G001", {
            "settings": memory_data,
            "analysis": memory_analysis
        }, node_name)

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

        bloated_tables_by_db = {}
        for db_name in databases:
            # Query table bloat using multiple metrics for each database
            bloat_queries = {
                'real_size': f'pgwatch_pg_table_bloat_real_size{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}',
                'extra_size': f'pgwatch_pg_table_bloat_extra_size{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}',
                'extra_pct': f'pgwatch_pg_table_bloat_extra_pct{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}',
                'bloat_size': f'pgwatch_pg_table_bloat_bloat_size{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}',
                'bloat_pct': f'pgwatch_pg_table_bloat_bloat_pct{{cluster="{cluster}", node_name="{node_name}", datname="{db_name}"}}',
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

            # Convert to list and add pretty formatting
            bloated_tables_list = []
            total_bloat_size = 0

            for table_data in bloated_tables.values():
                # Skip tables with minimal bloat
                if table_data['bloat_pct'] >= 10:  # Only report tables with >= 10% bloat
                    table_data['real_size_pretty'] = self.format_bytes(table_data['real_size'])
                    table_data['extra_size_pretty'] = self.format_bytes(table_data['extra_size'])
                    table_data['bloat_size_pretty'] = self.format_bytes(table_data['bloat_size'])

                    bloated_tables_list.append(table_data)
                    total_bloat_size += table_data['bloat_size']

            # Sort by bloat percentage descending
            bloated_tables_list.sort(key=lambda x: x['bloat_pct'], reverse=True)

            bloated_tables_by_db[db_name] = {
                "bloated_tables": bloated_tables_list,
                "total_count": len(bloated_tables_list),
                "total_bloat_size_bytes": total_bloat_size,
                "total_bloat_size_pretty": self.format_bytes(total_bloat_size)
            }

        return self.format_report_data("F004", bloated_tables_by_db, node_name)

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

        # Calculate time range
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=time_range_minutes)

        queries_by_db = {}
        for db_name in databases:
            # Get pg_stat_statements metrics for this database
            query_metrics = self._get_pgss_metrics_data_by_db(cluster, node_name, db_name, start_time, end_time)

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

        return self.format_report_data("K001", queries_by_db, node_name)

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

        # Calculate time range
        end_time = datetime.now()
        start_time = end_time - timedelta(minutes=time_range_minutes)

        queries_by_db = {}
        for db_name in databases:
            # Get pg_stat_statements metrics for this database
            query_metrics = self._get_pgss_metrics_data_by_db(cluster, node_name, db_name, start_time, end_time)

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

        return self.format_report_data("K003", queries_by_db, node_name)

    def _get_pgss_metrics_data(self, cluster: str, node_name: str, start_time: datetime, end_time: datetime) -> List[
        Dict[str, Any]]:
        """
        Get pg_stat_statements metrics data between two time points.
        Adapted from the logic in flask-backend/app.py get_pgss_metrics_csv().
        
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
        Adapted from the logic in flask-backend/app.py process_pgss_data().
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
        Adapted from the logic in flask-backend/app.py prometheus_to_dict().
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
            key = (
                metric.get('datname', ''),
                metric.get('queryid', ''),
                metric.get('user', ''),
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

    def format_report_data(self, check_id: str, data: Dict[str, Any], host: str = "target-database") -> Dict[str, Any]:
        """
        Format data to match template structure.
        
        Args:
            check_id: The check identifier
            data: The data to format
            host: Host identifier
            
        Returns:
            Dictionary formatted for templates
        """
        now = datetime.now()

        template_data = {
            "checkId": check_id,
            "timestamptz": now.isoformat(),
            "hosts": {
                "master": host,
                "replicas": []
            },
            "results": {
                host: {
                    "data": data
                }
            }
        }

        return template_data

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
            elif setting_name in ['autovacuum_analyze_scale_factor', 'autovacuum_vacuum_scale_factor']:
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

    def generate_all_reports(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
        """
        Generate all reports.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing all reports
        """
        reports = {}

        # Generate each report
        reports['A002'] = self.generate_a002_version_report(cluster, node_name)
        reports['A003'] = self.generate_a003_settings_report(cluster, node_name)
        reports['A004'] = self.generate_a004_cluster_report(cluster, node_name)
        reports['A007'] = self.generate_a007_altered_settings_report(cluster, node_name)
        reports['D004'] = self.generate_d004_pgstat_settings_report(cluster, node_name)
        reports['F001'] = self.generate_f001_autovacuum_settings_report(cluster, node_name)
        reports['F004'] = self.generate_f004_heap_bloat_report(cluster, node_name)
        reports['F005'] = self.generate_f005_btree_bloat_report(cluster, node_name)
        reports['G001'] = self.generate_g001_memory_settings_report(cluster, node_name)
        reports['H001'] = self.generate_h001_invalid_indexes_report(cluster, node_name)
        reports['H002'] = self.generate_h002_unused_indexes_report(cluster, node_name)
        reports['H004'] = self.generate_h004_redundant_indexes_report(cluster, node_name)
        reports['K001'] = self.generate_k001_query_calls_report(cluster, node_name)
        reports['K003'] = self.generate_k003_top_queries_report(cluster, node_name)

        return reports

    def get_all_databases(self, cluster: str = "local", node_name: str = "node-01") -> List[str]:
        """
        Get all databases from the metrics.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            List of database names
        """
        # Query for all databases using pg_stat_database metrics
        db_query = f'pgwatch_pg_stat_database_numbackends{{cluster="{cluster}", node_name="{node_name}"}}'
        result = self.query_instant(db_query)

        databases = []
        if result.get('status') == 'success' and result.get('data', {}).get('result'):
            for item in result['data']['result']:
                db_name = item['metric'].get('datname', '')
                if db_name and db_name not in databases:
                    databases.append(db_name)

        # If no databases found, try alternative query
        if not databases:
            db_query = f'pgwatch_pg_database_size_bytes{{cluster="{cluster}", node_name="{node_name}"}}'
            result = self.query_instant(db_query)
            if result.get('status') == 'success' and result.get('data', {}).get('result'):
                for item in result['data']['result']:
                    db_name = item['metric'].get('datname', '')
                    if db_name and db_name not in databases:
                        databases.append(db_name)

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
                print(f"Warning: Failed to query metric {metric} for database {db_name}: {e}")
                continue

        # Process the data to calculate differences
        return self._process_pgss_data(start_data, end_data, start_time, end_time, METRIC_NAME_MAPPING)

    def create_report(self, api_url, token, project, epoch):
        request_data = {
            "access_token": token,
            "project": project,
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
    parser.add_argument('--prometheus-url', default='http://localhost:9090',
                        help='Prometheus URL (default: http://localhost:9090)')
    parser.add_argument('--cluster', default='local',
                        help='Cluster name (default: local)')
    parser.add_argument('--node-name', default='node-01',
                        help='Node name (default: node-01)')
    parser.add_argument('--check-id',
                        choices=['A002', 'A003', 'A004', 'A007', 'D004', 'F001', 'F004', 'F005', 'G001', 'H001', 'H002',
                                 'H004', 'K001', 'K003', 'ALL'],
                        help='Specific check ID to generate (default: ALL)')
    parser.add_argument('--output', default='-',
                        help='Output file (default: stdout)')
    parser.add_argument('--api-url', default='https://postgres.ai/api/general')
    parser.add_argument('--token', default='')
    parser.add_argument('--project', default='project-name')
    parser.add_argument('--epoch', default='1')
    parser.add_argument('--no-upload', action='store_true', default=False,
                        help='Do not upload reports to the API')

    args = parser.parse_args()

    generator = PostgresReportGenerator(args.prometheus_url)

    # Test connection
    if not generator.test_connection():
        print("Error: Cannot connect to Prometheus. Make sure it's running and accessible.")
        sys.exit(1)

    try:
        if args.check_id == 'ALL' or args.check_id is None:
            # Generate all reports
            if not args.no_upload:
                report_id = generator.create_report(args.api_url, args.token, args.project, args.epoch)
            reports = generator.generate_all_reports(args.cluster, args.node_name)
            for report in reports:
                json.dump(reports[report], open(f"{report}.json", "w"))
                if not args.no_upload:
                    generator.upload_report_file(args.api_url, args.token, report_id, f"{report}.json")
            if args.output == '-':
                pass
            else:
                with open(args.output, 'w') as f:
                    json.dump(reports, f, indent=2)
                print(f"All reports written to {args.output}")
        else:
            # Generate specific report
            if args.check_id == 'A002':
                report = generator.generate_a002_version_report(args.cluster, args.node_name)
            elif args.check_id == 'A003':
                report = generator.generate_a003_settings_report(args.cluster, args.node_name)
            elif args.check_id == 'A004':
                report = generator.generate_a004_cluster_report(args.cluster, args.node_name)
            elif args.check_id == 'A007':
                report = generator.generate_a007_altered_settings_report(args.cluster, args.node_name)
            elif args.check_id == 'D004':
                report = generator.generate_d004_pgstat_settings_report(args.cluster, args.node_name)
            elif args.check_id == 'F001':
                report = generator.generate_f001_autovacuum_settings_report(args.cluster, args.node_name)
            elif args.check_id == 'F004':
                report = generator.generate_f004_heap_bloat_report(args.cluster, args.node_name)
            elif args.check_id == 'F005':
                report = generator.generate_f005_btree_bloat_report(args.cluster, args.node_name)
            elif args.check_id == 'G001':
                report = generator.generate_g001_memory_settings_report(args.cluster, args.node_name)
            elif args.check_id == 'G003':
                report = generator.generate_g003_database_stats_report(args.cluster, args.node_name)
            elif args.check_id == 'H001':
                report = generator.generate_h001_invalid_indexes_report(args.cluster, args.node_name)
            elif args.check_id == 'H002':
                report = generator.generate_h002_unused_indexes_report(args.cluster, args.node_name)
            elif args.check_id == 'H004':
                report = generator.generate_h004_redundant_indexes_report(args.cluster, args.node_name)
            elif args.check_id == 'K001':
                report = generator.generate_k001_query_calls_report(args.cluster, args.node_name)
            elif args.check_id == 'K003':
                report = generator.generate_k003_top_queries_report(args.cluster, args.node_name)

            if args.output == '-':
                print(json.dumps(report, indent=2))
            else:
                with open(args.output, 'w') as f:
                    json.dump(report, f, indent=2)
                if not args.no_upload:
                    generator.upload_report_file(args.api_url, args.token, args.project, args.epoch, args.output)
    except Exception as e:
        print(f"Error generating reports: {e}")
        raise e
        sys.exit(1)


if __name__ == "__main__":
    main()
