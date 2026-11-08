DROP TABLE IF EXISTS ai_tools;
ALTER TABLE ai_agent_config ADD COLUMN tools_enabled jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_agent_config ADD CONSTRAINT ai_agent_config_tools_check CHECK (jsonb_typeof(tools_enabled) = 'array');
ALTER TABLE ai_agent_config
  DROP CONSTRAINT IF EXISTS ai_agent_config_provider_check,
  DROP CONSTRAINT IF EXISTS ai_agent_config_base_url_check,
  DROP CONSTRAINT IF EXISTS ai_agent_config_key_last4_check,
  DROP COLUMN IF EXISTS pricing_per_1m,
  DROP COLUMN IF EXISTS fallback_model,
  DROP COLUMN IF EXISTS api_key_last4,
  DROP COLUMN IF EXISTS api_key_enc,
  DROP COLUMN IF EXISTS base_url,
  ALTER COLUMN provider SET DEFAULT 'anthropic';
