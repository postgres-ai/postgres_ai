from flask import Flask, request, jsonify, make_response
from prometheus_api_client import PrometheusConnect
import csv
import io
from datetime import datetime, timezone, timedelta
import logging
import os

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Prometheus connection - use environment variable with fallback
PROMETHEUS_URL = os.environ.get('PROMETHEUS_URL', 'http://localhost:8428')

# Metric name mapping for cleaner CSV output
METRIC_NAME_MAPPING = {
    'calls': 'calls',
    'exec_time_total': 'exec_time',
    'plan_time_total': 'plan_time',
    'rows': 'rows',
    'shared_bytes_hit_total': 'shared_blks_hit',
    'shared_bytes_read_total': 'shared_blks_read',
    'shared_bytes_dirtied_total': 'shared_blks_dirtied', 
    'shared_bytes_written_total': 'shared_blks_written',
    'block_read_total': 'blk_read_time',
    'block_write_total': 'blk_write_time'
}

def get_prometheus_client():
    """Get Prometheus client connection"""
    try:
        return PrometheusConnect(url=PROMETHEUS_URL, disable_ssl=True)
    except Exception as e:
        logger.error(f"Failed to connect to Prometheus: {e}")
        raise

def read_version_file(filepath, default='unknown'):
    """Read version information from file"""
    try:
        with open(filepath, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        return default


# Read version info at startup
APP_VERSION = read_version_file('/VERSION')
APP_BUILD_TS = read_version_file('/BUILD_TS')


@app.route('/version', methods=['GET'])
def version():
    """Return application version and build timestamp as array for Grafana Infinity datasource"""
    return jsonify([{
        "version": APP_VERSION,
        "build_ts": APP_BUILD_TS
    }])


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    try:
        prom = get_prometheus_client()
        # Simple query to test connection
        prom.get_current_metric_value(metric_name='up')
        return jsonify({"status": "healthy", "prometheus_url": PROMETHEUS_URL})
    except Exception as e:
        return jsonify({"status": "unhealthy", "error": str(e)}), 500

@app.route('/pgss_metrics/csv', methods=['GET'])
def get_pgss_metrics_csv():
    """
    Get pg_stat_statements metrics as CSV with time-based difference calculation

    Query parameters:
    - time_start: Start time (ISO format or Unix timestamp)
    - time_end: End time (ISO format or Unix timestamp)
    - cluster_name: Cluster name filter (optional)
    - node_name: Node name filter (optional)
    - db_name: Database name filter (optional)
    """
    try:
        # Get query parameters
        time_start = request.args.get('time_start')
        time_end = request.args.get('time_end')
        cluster_name = request.args.get('cluster_name')
        node_name = request.args.get('node_name')
        db_name = request.args.get('db_name')

        if not time_start or not time_end:
            return jsonify({"error": "time_start and time_end parameters are required"}), 400

        # Parse time parameters
        try:
            # Try parsing as Unix timestamp first
            start_dt = datetime.fromtimestamp(float(time_start), tz=timezone.utc)
        except ValueError:
            # Try parsing as ISO format
            start_dt = datetime.fromisoformat(time_start.replace('Z', '+00:00'))

        try:
            end_dt = datetime.fromtimestamp(float(time_end), tz=timezone.utc)
        except ValueError:
            end_dt = datetime.fromisoformat(time_end.replace('Z', '+00:00'))

        # Connect to Prometheus
        prom = get_prometheus_client()

        # Build the base query for pg_stat_statements metrics
        base_query = 'pgwatch_pg_stat_statements_calls'

        # Add filters if provided
        filters = []
        if cluster_name:
            filters.append(f'cluster="{cluster_name}"')
        if node_name:
            filters.append(f'instance=~".*{node_name}.*"')
        if db_name:
            filters.append(f'datname="{db_name}"')

        if filters:
            base_query += '{' + ','.join(filters) + '}'

        logger.info(f"Querying Prometheus with base query: {base_query}")

        # Get all pg_stat_statements metrics
        all_metrics = [
            'pgwatch_pg_stat_statements_calls',
            'pgwatch_pg_stat_statements_plans_total',
            'pgwatch_pg_stat_statements_exec_time_total',
            'pgwatch_pg_stat_statements_plan_time_total',
            'pgwatch_pg_stat_statements_rows',
            'pgwatch_pg_stat_statements_shared_bytes_hit_total',
            'pgwatch_pg_stat_statements_shared_bytes_read_total',
            'pgwatch_pg_stat_statements_shared_bytes_dirtied_total',
            'pgwatch_pg_stat_statements_shared_bytes_written_total',
            'pgwatch_pg_stat_statements_block_read_total',
            'pgwatch_pg_stat_statements_block_write_total',
            'pgwatch_pg_stat_statements_wal_records',
            'pgwatch_pg_stat_statements_wal_fpi',
            'pgwatch_pg_stat_statements_wal_bytes',
            'pgwatch_pg_stat_statements_temp_bytes_read',
            'pgwatch_pg_stat_statements_temp_bytes_written'
        ]

        # Apply filters to each metric
        filtered_metrics = []
        for metric in all_metrics:
            if filters:
                filtered_metrics.append(f'{metric}{{{",".join(filters)}}}')
            else:
                filtered_metrics.append(metric)

        # Get metrics at start and end times using instant queries
        start_data = []
        end_data = []

        for metric in filtered_metrics:
            try:
                start_metric_data = prom.get_metric_range_data(
                    metric_name=metric,
                    start_time=start_dt - timedelta(minutes=1),
                    end_time=start_dt + timedelta(minutes=1)
                )
                if start_metric_data:
                    start_data.extend(start_metric_data)

                end_metric_data = prom.get_metric_range_data(
                    metric_name=metric,
                    start_time=end_dt - timedelta(minutes=1),
                    end_time=end_dt + timedelta(minutes=1)
                )
                if end_metric_data:
                    end_data.extend(end_metric_data)
            except Exception as e:
                logger.warning(f"Failed to query metric {metric}: {e}")
                continue

        # Process the data to calculate differences
        csv_data = process_pgss_data(start_data, end_data, start_dt, end_dt)

        # Create CSV response
        output = io.StringIO()
        if csv_data:
            # Define explicit field order with queryid first, then duration, then metrics with their rates
            base_fields = ['queryid', 'duration_seconds']
            all_metric_fields = []
            
            # Get metric fields from the mapping in specific order with their rates
            desired_order = [
                'calls', 'exec_time', 'plan_time', 'rows', 'shared_blks_hit', 
                'shared_blks_read', 'shared_blks_dirtied', 'shared_blks_written',
                'blk_read_time', 'blk_write_time'
            ]
            
            for display_name in desired_order:
                if display_name in METRIC_NAME_MAPPING.values():
                    all_metric_fields.append(display_name)
                    all_metric_fields.append(f'{display_name}_per_sec')
                    all_metric_fields.append(f'{display_name}_per_call')
            
            # Combine all fields in desired order
            all_fields = base_fields + all_metric_fields
            
            writer = csv.DictWriter(output, fieldnames=all_fields)
            writer.writeheader()
            writer.writerows(csv_data)
        
        csv_content = output.getvalue()
        output.close()

        # Create response
        response = make_response(csv_content)
        response.headers['Content-Type'] = 'text/csv'
        response.headers['Content-Disposition'] = f'attachment; filename=pgss_metrics_{start_dt.strftime("%Y%m%d_%H%M%S")}_{end_dt.strftime("%Y%m%d_%H%M%S")}.csv'

        return response

    except Exception as e:
        logger.error(f"Error processing request: {e}")
        return jsonify({"error": str(e)}), 500

def process_pgss_data(start_data, end_data, start_time, end_time):
    """
    Process pg_stat_statements data and calculate differences between start and end times
    """
    # Convert Prometheus data to dictionaries
    start_metrics = prometheus_to_dict(start_data, start_time)
    end_metrics = prometheus_to_dict(end_data, end_time)

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
            'duration_seconds': actual_duration
        }

        # Numeric columns to calculate differences for (using original metric names)
        numeric_cols = list(METRIC_NAME_MAPPING.keys())
        
        # Calculate differences and rates
        for col in numeric_cols:
            start_val = start_metric.get(col, 0)
            end_val = end_metric.get(col, 0)
            diff = end_val - start_val
            
            # Use simplified display name for CSV columns
            display_name = METRIC_NAME_MAPPING[col]
            
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

    # Sort by total execution time difference (descending)
    result_rows.sort(key=lambda x: x.get('exec_time', 0), reverse=True)

    return result_rows

def prometheus_to_dict(prom_data, timestamp):
    """
    Convert Prometheus API response to dictionary keyed by query identifiers
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
                'timestamp': datetime.fromtimestamp(float(closest_value[0]), tz=timezone.utc).isoformat(),
            }

        # Add metric value
        metric_name = metric.get('__name__', 'pgwatch_pg_stat_statements_calls')
        clean_name = metric_name.replace('pgwatch_pg_stat_statements_', '')

        try:
            metrics_dict[key][clean_name] = float(closest_value[1])
        except (ValueError, IndexError):
            metrics_dict[key][clean_name] = 0

    return metrics_dict

@app.route('/metrics', methods=['GET'])
def list_metrics():
    """List available metrics in Prometheus"""
    try:
        prom = get_prometheus_client()
        metrics = prom.all_metrics()
        pgss_metrics = [m for m in metrics if 'pg_stat_statements' in m]
        return jsonify({"pg_stat_statements_metrics": pgss_metrics})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/debug/metrics', methods=['GET'])
def debug_metrics():
    """
    Debug endpoint to check what metrics are actually available in Prometheus
    """
    try:
        prom = get_prometheus_client()
        
        # Get all available metrics
        all_metrics = prom.all_metrics()
        
        # Filter for pg_btree_bloat metrics
        btree_metrics = [m for m in all_metrics if 'btree_bloat' in m]
        
        # Get sample data for each btree metric
        sample_data = {}
        for metric in btree_metrics[:5]:  # Limit to first 5 to avoid overwhelming
            try:
                result = prom.get_current_metric_value(metric_name=metric)
                sample_data[metric] = {
                    'count': len(result),
                    'sample_labels': [entry.get('metric', {}) for entry in result[:2]]  # First 2 entries
                }
            except Exception as e:
                sample_data[metric] = {'error': str(e)}
        
        return jsonify({
            'all_metrics_count': len(all_metrics),
            'btree_metrics': btree_metrics,
            'sample_data': sample_data
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/btree_bloat/csv', methods=['GET'])
def get_btree_bloat_csv():
    """
    Get the most recent pg_btree_bloat metrics as a CSV table.
    """
    try:
        # Get query parameters
        cluster_name = request.args.get('cluster_name')
        node_name = request.args.get('node_name')
        db_name = request.args.get('db_name')
        schemaname = request.args.get('schemaname')
        tblname = request.args.get('tblname')
        idxname = request.args.get('idxname')

        # Build label filters
        filters = []
        if cluster_name:
            filters.append(f'cluster="{cluster_name}"')
        if node_name:
            filters.append(f'node_name="{node_name}"')
        if schemaname:
            filters.append(f'schemaname="{schemaname}"')
        if tblname:
            filters.append(f'tblname="{tblname}"')
        if idxname:
            filters.append(f'idxname="{idxname}"')
        if db_name:
            filters.append(f'datname="{db_name}"')

        filter_str = '{' + ','.join(filters) + '}' if filters else ''

        # Metrics to fetch with last_over_time to get only the most recent value
        metric_queries = [
            f'last_over_time(pgwatch_pg_btree_bloat_real_size_mib{filter_str}[1d])',
            f'last_over_time(pgwatch_pg_btree_bloat_extra_size{filter_str}[1d])',
            f'last_over_time(pgwatch_pg_btree_bloat_extra_pct{filter_str}[1d])',
            f'last_over_time(pgwatch_pg_btree_bloat_fillfactor{filter_str}[1d])',
            f'last_over_time(pgwatch_pg_btree_bloat_bloat_size{filter_str}[1d])',
            f'last_over_time(pgwatch_pg_btree_bloat_bloat_pct{filter_str}[1d])',
            f'last_over_time(pgwatch_pg_btree_bloat_is_na{filter_str}[1d])',
        ]

        prom = get_prometheus_client()
        metric_results = {}

        for query in metric_queries:
            try:
                # Use custom_query instead of get_current_metric_value
                result = prom.custom_query(query=query)

                for entry in result:
                    metric_labels = entry.get('metric', {})
                    key = (
                        metric_labels.get('datname', ''),
                        metric_labels.get('schemaname', ''),
                        metric_labels.get('tblname', ''),
                        metric_labels.get('idxname', '')
                    )

                    if key not in metric_results:
                        metric_results[key] = {
                            'database': metric_labels.get('datname', ''),
                            'schemaname': metric_labels.get('schemaname', ''),
                            'tblname': metric_labels.get('tblname', ''),
                            'idxname': metric_labels.get('idxname', ''),
                        }

                    # Extract metric type from query and store value
                    if 'real_size_mib' in query:
                        metric_results[key]['real_size_mib'] = float(entry['value'][1])
                    elif 'extra_size' in query and 'extra_pct' not in query:
                        metric_results[key]['extra_size'] = float(entry['value'][1])
                    elif 'extra_pct' in query:
                        metric_results[key]['extra_pct'] = float(entry['value'][1])
                    elif 'fillfactor' in query:
                        metric_results[key]['fillfactor'] = float(entry['value'][1])
                    elif 'bloat_size' in query:
                        metric_results[key]['bloat_size'] = float(entry['value'][1])
                    elif 'bloat_pct' in query:
                        metric_results[key]['bloat_pct'] = float(entry['value'][1])
                    elif 'is_na' in query:
                        metric_results[key]['is_na'] = int(float(entry['value'][1]))

            except Exception as e:
                logger.warning(f"Failed to query: {query}, error: {e}")
                continue

        # Prepare CSV output
        output = io.StringIO()
        fieldnames = [
            'database', 'schemaname', 'tblname', 'idxname',
            'real_size_mib', 'extra_size', 'extra_pct', 'fillfactor',
            'bloat_size', 'bloat_pct', 'is_na'
        ]
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        for row in metric_results.values():
            writer.writerow(row)

        csv_content = output.getvalue()
        output.close()

        # Create response
        response = make_response(csv_content)
        response.headers['Content-Type'] = 'text/csv'
        response.headers['Content-Disposition'] = 'attachment; filename=btree_bloat_latest.csv'
        return response

    except Exception as e:
        logger.error(f"Error processing btree bloat request: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/table_info/csv', methods=['GET'])
def get_table_info_csv():
    """
    Get comprehensive table information including size metrics, tuple statistics, and I/O statistics as a CSV table.
    Supports both instant queries (without time parameters) and rate calculations over a time period.
    
    Query parameters:
    - time_start: Start time (ISO format or Unix timestamp) - optional
    - time_end: End time (ISO format or Unix timestamp) - optional
    - cluster_name: Cluster name filter (optional)
    - node_name: Node name filter (optional)
    - db_name: Database name filter (optional)
    - schemaname: Schema name filter (optional, supports regex with ~)
    - tblname: Table name filter (optional)
    """
    try:
        # Get query parameters
        time_start = request.args.get('time_start')
        time_end = request.args.get('time_end')
        cluster_name = request.args.get('cluster_name')
        node_name = request.args.get('node_name')
        db_name = request.args.get('db_name')
        schemaname = request.args.get('schemaname')
        tblname = request.args.get('tblname')

        # Determine if we should calculate rates
        calculate_rates = bool(time_start and time_end)
        
        if calculate_rates:
            # Parse time parameters
            try:
                start_dt = datetime.fromtimestamp(float(time_start), tz=timezone.utc)
            except ValueError:
                start_dt = datetime.fromisoformat(time_start.replace('Z', '+00:00'))

            try:
                end_dt = datetime.fromtimestamp(float(time_end), tz=timezone.utc)
            except ValueError:
                end_dt = datetime.fromisoformat(time_end.replace('Z', '+00:00'))

        # Build label filters
        filters = []
        if cluster_name:
            filters.append(f'cluster="{cluster_name}"')
        if node_name:
            filters.append(f'node_name="{node_name}"')
        if schemaname:
            # Support regex pattern matching with =~
            filters.append(f'schemaname=~"{schemaname}"')
        if tblname:
            filters.append(f'tblname="{tblname}"')
        if db_name:
            filters.append(f'datname="{db_name}"')

        filter_str = '{' + ','.join(filters) + '}' if filters else ''

        prom = get_prometheus_client()
        
        # Define base metrics to query (without last_over_time wrapper for rate calculation)
        base_metrics = {
            # Size metrics
            'total_size': f'pgwatch_pg_class_total_relation_size_bytes{filter_str}',
            'table_size': f'pgwatch_table_size_detailed_table_main_size_b{filter_str}',
            'index_size': f'pgwatch_table_size_detailed_table_indexes_size_b{filter_str}',
            'toast_size': f'pgwatch_table_size_detailed_total_toast_size_b{filter_str}',
            # Scan statistics
            'seq_scan': f'pgwatch_pg_stat_all_tables_seq_scan{filter_str}',
            'idx_scan': f'pgwatch_pg_stat_all_tables_idx_scan{filter_str}',
            # Tuple statistics
            'n_tup_ins': f'pgwatch_table_stats_n_tup_ins{filter_str}',
            'n_tup_upd': f'pgwatch_table_stats_n_tup_upd{filter_str}',
            'n_tup_del': f'pgwatch_table_stats_n_tup_del{filter_str}',
            'n_tup_hot_upd': f'pgwatch_table_stats_n_tup_hot_upd{filter_str}',
            # I/O statistics
            'heap_blks_read': f'pgwatch_pg_statio_all_tables_heap_blks_read{filter_str}',
            'heap_blks_hit': f'pgwatch_pg_statio_all_tables_heap_blks_hit{filter_str}',
            'idx_blks_read': f'pgwatch_pg_statio_all_tables_idx_blks_read{filter_str}',
            'idx_blks_hit': f'pgwatch_pg_statio_all_tables_idx_blks_hit{filter_str}',
        }
        
        if calculate_rates:
            # Get metrics at start and end times
            start_data = {}
            end_data = {}
            
            for metric_name, metric_query in base_metrics.items():
                try:
                    # Get data at start time
                    start_result = prom.get_metric_range_data(
                        metric_name=metric_query,
                        start_time=start_dt - timedelta(minutes=1),
                        end_time=start_dt + timedelta(minutes=1)
                    )
                    if start_result:
                        start_data[metric_name] = start_result
                    
                    # Get data at end time
                    end_result = prom.get_metric_range_data(
                        metric_name=metric_query,
                        start_time=end_dt - timedelta(minutes=1),
                        end_time=end_dt + timedelta(minutes=1)
                    )
                    if end_result:
                        end_data[metric_name] = end_result
                except Exception as e:
                    logger.warning(f"Failed to query metric {metric_name}: {e}")
                    continue
            
            # Process the data to calculate rates
            metric_results = process_table_stats_with_rates(start_data, end_data, start_dt, end_dt)
        else:
            # Get instant values using last_over_time
            metric_results = {}
            for metric_name, metric_query in base_metrics.items():
                try:
                    result = prom.custom_query(query=f'last_over_time({metric_query}[1d])')
                    for entry in result:
                        metric_labels = entry.get('metric', {})
                        
                        # Use different key depending on label names
                        schema_label = metric_labels.get('schemaname') or metric_labels.get('schema', '')
                        table_label = metric_labels.get('relname') or metric_labels.get('table_name') or metric_labels.get('tblname', '')
                        
                        key = (
                            metric_labels.get('datname', ''),
                            schema_label,
                            table_label,
                        )
                        
                        if key not in metric_results:
                            metric_results[key] = {
                                'database': metric_labels.get('datname', ''),
                                'schema': schema_label,
                                'table_name': table_label,
                            }
                        
                        value = float(entry['value'][1])
                        metric_results[key][metric_name] = value
                except Exception as e:
                    logger.warning(f"Failed to query metric {metric_name}: {e}")
                    continue

        # Prepare CSV output
        output = io.StringIO()
        
        if calculate_rates:
            # Fields with rate calculations
            fieldnames = [
                'schema', 'table_name',
                # Size metrics (bytes)
                'total_size', 'table_size', 'index_size', 'toast_size',
                # Scan statistics with rates
                'seq_scans', 'seq_scans_per_sec',
                'idx_scans', 'idx_scans_per_sec',
                # Tuple statistics with rates
                'inserts', 'inserts_per_sec',
                'updates', 'updates_per_sec',
                'deletes', 'deletes_per_sec',
                'hot_updates', 'hot_updates_per_sec',
                # I/O statistics with rates (in bytes using block_size)
                'heap_blks_read', 'heap_blks_read_per_sec',
                'heap_blks_hit', 'heap_blks_hit_per_sec',
                'idx_blks_read', 'idx_blks_read_per_sec',
                'idx_blks_hit', 'idx_blks_hit_per_sec',
                'duration_seconds'
            ]
        else:
            # Fields without rate calculations
            fieldnames = [
                'schema', 'table_name',
                'total_size', 'table_size', 'index_size', 'toast_size',
                'seq_scan', 'idx_scan',
                'n_tup_ins', 'n_tup_upd', 'n_tup_del', 'n_tup_hot_upd',
                'heap_blks_read', 'heap_blks_hit',
                'idx_blks_read', 'idx_blks_hit'
            ]
            
            # Remove 'database' field from rows if present (not in fieldnames)
            for row in metric_results.values():
                row.pop('database', None)
        
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        
        # Write rows (handle both dict and list)
        if isinstance(metric_results, dict):
            rows = metric_results.values()
        else:
            rows = metric_results
        
        for row in rows:
            writer.writerow(row)

        csv_content = output.getvalue()
        output.close()

        # Create response
        response = make_response(csv_content)
        response.headers['Content-Type'] = 'text/csv'
        
        if calculate_rates:
            filename = f'table_stats_{start_dt.strftime("%Y%m%d_%H%M%S")}_{end_dt.strftime("%Y%m%d_%H%M%S")}.csv'
        else:
            filename = 'table_stats_latest.csv'
        
        response.headers['Content-Disposition'] = f'attachment; filename={filename}'
        return response

    except Exception as e:
        logger.error(f"Error processing table stats request: {e}")
        return jsonify({"error": str(e)}), 500

def process_table_stats_with_rates(start_data, end_data, start_time, end_time):
    """
    Process table statistics and calculate rates between start and end times
    """
    # Convert data to dictionaries
    start_metrics = prometheus_table_to_dict(start_data, start_time)
    end_metrics = prometheus_table_to_dict(end_data, end_time)
    
    if not start_metrics and not end_metrics:
        return []
    
    # Get all unique table identifiers
    all_keys = set()
    all_keys.update(start_metrics.keys())
    all_keys.update(end_metrics.keys())
    
    result_rows = []
    
    for key in all_keys:
        start_metric = start_metrics.get(key, {})
        end_metric = end_metrics.get(key, {})
        
        # Extract identifier components from key
        db_name, schema_name, table_name = key
        
        # Calculate actual duration
        start_timestamp = start_metric.get('timestamp')
        end_timestamp = end_metric.get('timestamp')
        
        if start_timestamp and end_timestamp:
            start_dt = datetime.fromisoformat(start_timestamp)
            end_dt = datetime.fromisoformat(end_timestamp)
            actual_duration = (end_dt - start_dt).total_seconds()
        else:
            actual_duration = (end_time - start_time).total_seconds()
        
        # Create result row
        row = {
            'schema': schema_name,
            'table_name': table_name,
            'duration_seconds': actual_duration
        }
        
        # Counter metrics to calculate differences and rates
        counter_metrics = [
            'seq_scan', 'idx_scan', 'n_tup_ins', 'n_tup_upd', 
            'n_tup_del', 'n_tup_hot_upd', 'heap_blks_read', 'heap_blks_hit',
            'idx_blks_read', 'idx_blks_hit'
        ]
        
        # Mapping for display names
        display_names = {
            'seq_scan': 'seq_scans',
            'idx_scan': 'idx_scans',
            'n_tup_ins': 'inserts',
            'n_tup_upd': 'updates',
            'n_tup_del': 'deletes',
            'n_tup_hot_upd': 'hot_updates',
        }
        
        # Calculate differences and rates
        for metric in counter_metrics:
            start_val = start_metric.get(metric, 0)
            end_val = end_metric.get(metric, 0)
            diff = end_val - start_val
            
            # Use display name if available
            display_name = display_names.get(metric, metric)
            
            row[display_name] = diff
            
            # Calculate rate per second
            if actual_duration > 0:
                row[f'{display_name}_per_sec'] = diff / actual_duration
            else:
                row[f'{display_name}_per_sec'] = 0
        
        # Size metrics (just use end values, these don't need rates)
        for size_metric in ['total_size', 'table_size', 'index_size', 'toast_size']:
            row[size_metric] = end_metric.get(size_metric, 0)
        
        result_rows.append(row)
    
    # Sort by total size descending
    result_rows.sort(key=lambda x: x.get('total_size', 0), reverse=True)
    
    return result_rows

def prometheus_table_to_dict(prom_data, timestamp):
    """
    Convert Prometheus table metrics to dictionary keyed by table identifiers
    """
    if not prom_data:
        return {}
    
    metrics_dict = {}
    
    for metric_name, metric_results in prom_data.items():
        for metric_data in metric_results:
            metric = metric_data.get('metric', {})
            values = metric_data.get('values', [])
            
            if not values:
                continue
            
            # Get the closest value to our timestamp
            closest_value = min(values, key=lambda x: abs(float(x[0]) - timestamp.timestamp()))
            
            # Handle different label names
            schema_label = metric.get('schemaname') or metric.get('schema', '')
            table_label = metric.get('relname') or metric.get('table_name') or metric.get('tblname', '')
            
            # Create unique key for this table
            key = (
                metric.get('datname', ''),
                schema_label,
                table_label,
            )
            
            # Initialize metric dict if not exists
            if key not in metrics_dict:
                metrics_dict[key] = {
                    'timestamp': datetime.fromtimestamp(float(closest_value[0]), tz=timezone.utc).isoformat(),
                }
            
            # Add metric value
            try:
                metrics_dict[key][metric_name] = float(closest_value[1])
            except (ValueError, IndexError):
                metrics_dict[key][metric_name] = 0
    
    return metrics_dict

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True) 