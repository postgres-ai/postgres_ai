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



-- Create a partitioned table for queryid-to-query mappings with LIST partitioning by dbname
CREATE TABLE IF NOT EXISTS public.pgss_queryid_queries (
    time TIMESTAMPTZ NOT NULL,
    dbname TEXT NOT NULL,
    data JSONB NOT NULL,
    tag_data JSONB
) PARTITION BY LIST (dbname);

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS pgss_queryid_queries_dbname_time_idx ON public.pgss_queryid_queries (dbname, time);

-- Use existing subpartitions schema


-- Set ownership and grant permissions to pgwatch
ALTER TABLE public.pgss_queryid_queries OWNER TO pgwatch;
GRANT ALL PRIVILEGES ON TABLE public.pgss_queryid_queries TO pgwatch;
-- Ensure pgwatch can use sequences (if any are created)
GRANT USAGE ON SCHEMA public TO pgwatch;
-- Grant permissions on all future tables in public schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO pgwatch; 

CREATE OR REPLACE FUNCTION enforce_queryid_uniqueness()
RETURNS TRIGGER AS $$
DECLARE
    queryid_value TEXT;
BEGIN
    -- Extract queryid from the data JSONB
    queryid_value := NEW.data->>'queryid';
    
    -- Allow NULL queryids through
    IF queryid_value IS NULL THEN
        RETURN NEW;
    END IF;
    
    -- Silently skip if duplicate exists
    IF EXISTS (
        SELECT 1 
        FROM pgss_queryid_queries
        WHERE dbname = NEW.dbname
          AND data->>'queryid' = queryid_value
        LIMIT 1
    ) THEN
        RETURN NULL;  -- Cancels INSERT silently
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE TRIGGER enforce_queryid_uniqueness_trigger
    BEFORE INSERT
    ON pgss_queryid_queries
    FOR EACH ROW
    EXECUTE FUNCTION enforce_queryid_uniqueness();


