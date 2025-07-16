#!/usr/bin/env python3
"""
PostgreSQL Reports Generator using PromQL

This script generates reports for specific PostgreSQL check types (A002, A003, A004, A007, H001, F005, F004)
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
            "server_major_ver": version_data.get('server_version', '').split('.')[0] if version_data.get('server_version') else 'Unknown',
            "server_minor_ver": version_data.get('server_version', '').split('.', 1)[1] if version_data.get('server_version') and '.' in version_data.get('server_version', '') else 'Unknown'
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
    
    def generate_a007_altered_settings_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
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
    
    def generate_h001_invalid_indexes_report(self, cluster: str = "local", node_name: str = "node-01") -> Dict[str, Any]:
        """
        Generate H001 Invalid Indexes report.
        
        Args:
            cluster: Cluster name
            node_name: Node name
            
        Returns:
            Dictionary containing invalid indexes information
        """
        print("Generating H001 Invalid Indexes report...")
        
        # Query invalid indexes using the pgwatch_pg_invalid_indexes metric
        invalid_indexes_query = f'pgwatch_pg_invalid_indexes{{cluster="{cluster}", node_name="{node_name}"}}'
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
        
        return self.format_report_data("H001", {
            "invalid_indexes": invalid_indexes,
            "total_count": len(invalid_indexes),
            "total_size_bytes": total_size,
            "total_size_pretty": self.format_bytes(total_size)
        }, node_name)
    
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
        
        # Query btree bloat using multiple metrics
        bloat_queries = {
            'extra_size': f'pgwatch_pg_btree_bloat_extra_size{{cluster="{cluster}", node_name="{node_name}"}}',
            'extra_pct': f'pgwatch_pg_btree_bloat_extra_pct{{cluster="{cluster}", node_name="{node_name}"}}',
            'bloat_size': f'pgwatch_pg_btree_bloat_bloat_size{{cluster="{cluster}", node_name="{node_name}"}}',
            'bloat_pct': f'pgwatch_pg_btree_bloat_bloat_pct{{cluster="{cluster}", node_name="{node_name}"}}',
        }
        
        bloated_indexes = {}
        
        for metric_type, query in bloat_queries.items():
            result = self.query_instant(query)
            if result.get('status') == 'success' and result.get('data', {}).get('result'):
                for item in result['data']['result']:
                    print(item)
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
        
        return self.format_report_data("F005", {
            "bloated_indexes": bloated_indexes_list,
            "total_count": len(bloated_indexes_list),
            "total_bloat_size_bytes": total_bloat_size,
            "total_bloat_size_pretty": self.format_bytes(total_bloat_size)
        }, node_name)
    
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
        
        # Query table bloat using multiple metrics
        bloat_queries = {
            'real_size': f'pgwatch_pg_table_bloat_real_size{{cluster="{cluster}", node_name="{node_name}"}}',
            'extra_size': f'pgwatch_pg_table_bloat_extra_size{{cluster="{cluster}", node_name="{node_name}"}}',
            'extra_pct': f'pgwatch_pg_table_bloat_extra_pct{{cluster="{cluster}", node_name="{node_name}"}}',
            'bloat_size': f'pgwatch_pg_table_bloat_bloat_size{{cluster="{cluster}", node_name="{node_name}"}}',
            'bloat_pct': f'pgwatch_pg_table_bloat_bloat_pct{{cluster="{cluster}", node_name="{node_name}"}}',
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
        
        return self.format_report_data("F004", {
            "bloated_tables": bloated_tables_list,
            "total_count": len(bloated_tables_list),
            "total_bloat_size_bytes": total_bloat_size,
            "total_bloat_size_pretty": self.format_bytes(total_bloat_size)
        }, node_name)

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
                elif unit == "connections":
                    return f"{value} connections"
                elif unit == "workers":
                    return f"{value} workers"
                else:
                    return f"{value} {unit}"
            
            # Fallback to setting name based formatting
            if setting_name in ['shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem']:
                val = int(value)
                if val >= 1024:
                    return f"{val // 1024} MB"
                else:
                    return f"{val} kB"
            elif setting_name in ['log_min_duration_statement', 'idle_in_transaction_session_timeout', 'lock_timeout', 'statement_timeout']:
                val = int(value)
                if val >= 1000:
                    return f"{val // 1000} s"
                else:
                    return f"{val} ms"
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
        reports['H001'] = self.generate_h001_invalid_indexes_report(cluster, node_name)
        reports['F005'] = self.generate_f005_btree_bloat_report(cluster, node_name)
        reports['F004'] = self.generate_f004_heap_bloat_report(cluster, node_name)
        
        return reports
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
    parser.add_argument('--check-id', choices=['A002', 'A003', 'A004', 'A007', 'H001', 'F005', 'F004', 'ALL'],
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
            elif args.check_id == 'H001':
                report = generator.generate_h001_invalid_indexes_report(args.cluster, args.node_name)
            elif args.check_id == 'F005':
                report = generator.generate_f005_btree_bloat_report(args.cluster, args.node_name)
            elif args.check_id == 'F004':
                report = generator.generate_f004_heap_bloat_report(args.cluster, args.node_name)
            
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