-- Initialize PostgreSQL sink database for storing pgwatch measurements
-- This database will store all the monitoring metrics collected by PGWatch
-- Based on https://pgwat.ch/latest/howto/metrics_db_bootstrap.html

-- Create the pgwatch role for measurements database
CREATE ROLE pgwatch WITH LOGIN PASSWORD 'pgwatchadmin';

-- Create the measurements database owned by pgwatch
CREATE DATABASE measurements OWNER pgwatch;

-- Switch to the measurements database context
\c measurements;

-- Create extensions that might be useful for metrics storage
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Grant necessary permissions to pgwatch user
GRANT ALL PRIVILEGES ON DATABASE measurements TO pgwatch;
GRANT ALL PRIVILEGES ON SCHEMA public TO pgwatch;

-- pgwatch will automatically create the admin and subpartitions schemas
-- and all necessary tables when it starts up 