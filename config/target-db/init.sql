-- Initialize target database for monitoring
-- Enable pg_stat_statements extension for query monitoring
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Create a sample table for demonstration
CREATE TABLE IF NOT EXISTS sample_data (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert some sample data
INSERT INTO sample_data (name) VALUES 
    ('Sample Record 1'),
    ('Sample Record 2'),
    ('Sample Record 3');

-- Create a user for PGWatch monitoring
CREATE USER monitor WITH PASSWORD 'monitor_pass';
GRANT CONNECT ON DATABASE target_database TO monitor;
GRANT USAGE ON SCHEMA public TO monitor;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO monitor;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO monitor;

-- Grant access to monitoring views
GRANT SELECT ON pg_stat_statements TO monitor;
GRANT SELECT ON pg_stat_database TO monitor;
GRANT SELECT ON pg_stat_user_tables TO monitor; 
-- Grant pg_monitor role to monitor user for enhanced monitoring capabilities
GRANT pg_monitor TO monitor;
