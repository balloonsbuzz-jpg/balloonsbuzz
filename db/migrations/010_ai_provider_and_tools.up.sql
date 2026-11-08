-- 010 AI provider settings (DeepSeek default, key editable from the UI) and an
--     editable tools table (replaces ai_agent_config.tools_enabled).
-- Mirrors Whapter: DeepSeek via DEEPSEEK_API_KEY / api.deepseek.com, tenant
-- overrides of tool descriptions + on/off (agent_tools), prompt in the DB.

ALTER TABLE ai_agent_config
  ALTER COLUMN provider SET DEFAULT 'deepseek',
  ADD COLUMN base_url        text,      -- NULL = provider default (https://api.deepseek.com)
  ADD COLUMN api_key_enc     text,      -- AES-256-GCM ciphertext set from the UI; NULL = use env key
  ADD COLUMN api_key_last4   text,      -- shown in the UI as ••••abcd, never the key itself
  ADD COLUMN fallback_model  text,      -- tried once if the primary model errors
  ADD COLUMN pricing_per_1m  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"input":..,"cached_input":..,"output":..} in USD for cost tracking
  ADD CONSTRAINT ai_agent_config_provider_check CHECK (provider = ANY (ARRAY[
    'deepseek','openai','anthropic','gemini','groq','openrouter','custom'])),
  ADD CONSTRAINT ai_agent_config_base_url_check CHECK (base_url IS NULL OR base_url ~ '^https?://'),
  ADD CONSTRAINT ai_agent_config_key_last4_check CHECK (api_key_last4 IS NULL OR length(api_key_last4) <= 4);

-- Move the placeholder seed row (if still untouched) from Anthropic to DeepSeek.
UPDATE ai_agent_config
   SET provider = 'deepseek', model = 'deepseek-chat', fallback_model = 'deepseek-reasoner'
 WHERE provider = 'anthropic' AND system_prompt LIKE 'PLACEHOLDER:%';

ALTER TABLE ai_agent_config DROP COLUMN tools_enabled;

-- ── ai_tools: the agent's tools, editable from the AI Agent screen ──
-- Code implements each tool (by `name`); the admin edits what the model sees
-- (description), switches tools on/off, and tunes per-tool settings (config).
CREATE TABLE ai_tools (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,                 -- function name sent to the model; must match a code implementation
  display_name  text NOT NULL,
  description   text NOT NULL,                 -- editable: what the model reads to decide when to call it
  default_description text NOT NULL,           -- shipped text, for "reset to default"
  parameters    jsonb NOT NULL DEFAULT '{"type":"object","properties":{}}'::jsonb,  -- JSON schema (code-owned)
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- editable per-tool settings, e.g. {"default_count":3,"max_count":5}
  is_enabled    boolean NOT NULL DEFAULT true,
  is_required   boolean NOT NULL DEFAULT false, -- safety tools (pricing, negotiation, handover) cannot be switched off
  sort_order    integer NOT NULL DEFAULT 0,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_tools_tenant_name UNIQUE (tenant_id, name),
  CONSTRAINT ai_tools_name_check CHECK (name ~ '^[a-z_]{2,64}$'),
  CONSTRAINT ai_tools_required_enabled_check CHECK (is_enabled OR NOT is_required),
  CONSTRAINT ai_tools_description_check CHECK (length(btrim(description)) BETWEEN 10 AND 2000),
  CONSTRAINT ai_tools_parameters_check CHECK (jsonb_typeof(parameters) = 'object'),
  CONSTRAINT ai_tools_config_check CHECK (jsonb_typeof(config) = 'object')
);
CREATE INDEX idx_ai_tools_tenant_id ON ai_tools (tenant_id);
CREATE INDEX idx_ai_tools_updated_by ON ai_tools (updated_by);
CREATE TRIGGER trg_ai_tools_updated_at BEFORE UPDATE ON ai_tools
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
