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

-- Create a public view for pg_statistic access
CREATE OR REPLACE VIEW public.pg_statistic AS
SELECT 
    n.nspname as schemaname,
    c.relname as tablename,
    a.attname,
    s.stanullfrac as null_frac,
    s.stawidth as avg_width,
    false as inherited
FROM pg_statistic s
JOIN pg_class c ON c.oid = s.starelid
JOIN pg_namespace n ON n.oid = c.relnamespace  
JOIN pg_attribute a ON a.attrelid = s.starelid AND a.attnum = s.staattnum
WHERE a.attnum > 0 AND NOT a.attisdropped;

-- Grant specific access instead of all tables
GRANT SELECT ON public.pg_statistic TO pg_monitor;

-- Grant access to monitoring views
GRANT SELECT ON pg_stat_statements TO monitor;
GRANT SELECT ON pg_stat_database TO monitor;
GRANT SELECT ON pg_stat_user_tables TO monitor; 
-- Grant pg_monitor role to monitor user for enhanced monitoring capabilities
GRANT pg_monitor TO monitor;

-- Set search path for the monitor user
ALTER USER monitor SET search_path = "$user", public, pg_catalog;
