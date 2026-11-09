ALTER TABLE ai_agent_config ALTER COLUMN handover_keywords SET DEFAULT '["human","agent","call me","person","manager"]'::jsonb;
-- rows are left as they are (admin edits must not be reverted)
