from flask import Flask, request, jsonify, make_response
from prometheus_api_client import PrometheusConnect
import csv
import io
from datetime import datetime, timezone, timedelta
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Prometheus connection
PROMETHEUS_URL = "http://sink-prometheus:9090"

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

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True) 