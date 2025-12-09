-- Create dify_plugin database if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'dify_plugin') THEN
        CREATE DATABASE dify_plugin;
    END IF;
END
$$;

