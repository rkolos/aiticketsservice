-- Create dify_plugin database if it doesn't exist
-- Note: We can't use DO block to create databases, so we use a simpler approach
SELECT 'CREATE DATABASE dify_plugin'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'dify_plugin')\gexec

