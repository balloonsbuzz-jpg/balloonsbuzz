DROP TABLE IF EXISTS audit_log;
DROP FUNCTION IF EXISTS audit_log_immutable() CASCADE;
DROP TABLE IF EXISTS ai_tool_calls;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_ai_run_id_fkey;
DROP TABLE IF EXISTS ai_runs;
DROP TABLE IF EXISTS webhook_events;
