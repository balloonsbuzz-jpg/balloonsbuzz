-- 002 Settings: WhatsApp account, business settings, AI agent config (+ prompt versions), FAQ snippets

-- ── whatsapp_accounts (Whapter: whatsapp_accounts) ───────────
CREATE TABLE whatsapp_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_phone      text NOT NULL,                -- digits, e.g. 919392534625
  display_name       text,
  phone_number_id    text NOT NULL,                -- Meta phone_number_id (webhook routing key)
  waba_id            text NOT NULL,
  access_token_enc   text,                         -- AES-256-GCM ciphertext; NULL => use env token
  status             text NOT NULL DEFAULT 'pending',
  is_primary         boolean NOT NULL DEFAULT true,
  read_receipts_enabled boolean NOT NULL DEFAULT true,
  last_health_check_at timestamptz,
  last_health_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_whatsapp_accounts_phone_number_id UNIQUE (phone_number_id),
  CONSTRAINT whatsapp_accounts_status_check CHECK (status = ANY (ARRAY['pending','connected','disconnected','error'])),
  CONSTRAINT whatsapp_accounts_display_phone_check CHECK (display_phone ~ '^[1-9][0-9]{7,14}$')
);
CREATE INDEX idx_whatsapp_accounts_tenant_id ON whatsapp_accounts (tenant_id);
CREATE UNIQUE INDEX uq_whatsapp_accounts_tenant_primary ON whatsapp_accounts (tenant_id) WHERE is_primary;
CREATE TRIGGER trg_whatsapp_accounts_updated_at BEFORE UPDATE ON whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── business_settings (one row per tenant) ───────────────────
CREATE TABLE business_settings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_name          text NOT NULL,
  base_address           text,
  base_lat               numeric(9,6),             -- Miyapur base pin (TO CONFIRM with client)
  base_lng               numeric(9,6),
  road_factor            numeric(4,2) NOT NULL DEFAULT 1.30,   -- straight-line -> road estimate
  max_service_km         numeric(6,2),
  advance_type           text NOT NULL DEFAULT 'percent',
  advance_value          numeric(12,2),            -- % or ₹ depending on advance_type
  min_lead_time_hours    integer NOT NULL DEFAULT 24,
  max_bookings_per_day   integer,
  working_hours          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"mon":[["09:00","21:00"]], ...}
  staff_alert_phones     text[] NOT NULL DEFAULT '{}',
  upi_vpa                text,
  upi_payee_name         text,
  extra                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_business_settings_tenant UNIQUE (tenant_id),
  CONSTRAINT business_settings_lat_check CHECK (base_lat IS NULL OR base_lat BETWEEN -90 AND 90),
  CONSTRAINT business_settings_lng_check CHECK (base_lng IS NULL OR base_lng BETWEEN -180 AND 180),
  CONSTRAINT business_settings_road_factor_check CHECK (road_factor BETWEEN 1.00 AND 3.00),
  CONSTRAINT business_settings_max_km_check CHECK (max_service_km IS NULL OR max_service_km > 0),
  CONSTRAINT business_settings_advance_type_check CHECK (advance_type = ANY (ARRAY['percent','fixed'])),
  CONSTRAINT business_settings_advance_value_check CHECK (
    advance_value IS NULL OR (advance_value >= 0 AND (advance_type <> 'percent' OR advance_value <= 100))),
  CONSTRAINT business_settings_lead_time_check CHECK (min_lead_time_hours >= 0),
  CONSTRAINT business_settings_capacity_check CHECK (max_bookings_per_day IS NULL OR max_bookings_per_day > 0)
);
CREATE TRIGGER trg_business_settings_updated_at BEFORE UPDATE ON business_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── ai_agent_config (Whapter: tenant_ai_settings) ────────────
CREATE TABLE ai_agent_config (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  is_enabled             boolean NOT NULL DEFAULT true,     -- global kill switch for the bot
  provider               text NOT NULL DEFAULT 'anthropic',
  model                  text NOT NULL,
  system_prompt          text NOT NULL,
  temperature            numeric(3,2) NOT NULL DEFAULT 0.40,
  max_output_tokens      integer NOT NULL DEFAULT 600,
  max_tool_iterations    integer NOT NULL DEFAULT 6,
  max_history_messages   integer NOT NULL DEFAULT 20,
  summary_every_messages integer NOT NULL DEFAULT 20,
  max_message_chars      integer NOT NULL DEFAULT 300,      -- "short and sweet": longer replies are split
  max_messages_per_turn  integer NOT NULL DEFAULT 3,
  response_delay_min_ms  integer NOT NULL DEFAULT 1500,
  response_delay_max_ms  integer NOT NULL DEFAULT 4000,
  stuck_threshold        integer NOT NULL DEFAULT 3,        -- failed/confused turns before auto-handover
  handover_keywords      jsonb NOT NULL DEFAULT '["human","agent","call me","person","manager"]'::jsonb,
  tools_enabled          jsonb NOT NULL DEFAULT '[]'::jsonb,
  handover_message       text,
  out_of_hours_message   text,
  settings               jsonb NOT NULL DEFAULT '{}'::jsonb,
  version                integer NOT NULL DEFAULT 1,
  updated_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_agent_config_tenant UNIQUE (tenant_id),
  CONSTRAINT ai_agent_config_temperature_check CHECK (temperature BETWEEN 0 AND 2),
  CONSTRAINT ai_agent_config_limits_check CHECK (
    max_output_tokens > 0 AND max_tool_iterations BETWEEN 1 AND 20 AND max_history_messages BETWEEN 1 AND 200
    AND max_message_chars BETWEEN 50 AND 4096 AND max_messages_per_turn BETWEEN 1 AND 10
    AND stuck_threshold >= 1 AND summary_every_messages >= 1),
  CONSTRAINT ai_agent_config_delay_check CHECK (
    response_delay_min_ms >= 0 AND response_delay_max_ms >= response_delay_min_ms),
  CONSTRAINT ai_agent_config_keywords_check CHECK (jsonb_typeof(handover_keywords) = 'array'),
  CONSTRAINT ai_agent_config_tools_check CHECK (jsonb_typeof(tools_enabled) = 'array')
);
CREATE INDEX idx_ai_agent_config_updated_by ON ai_agent_config (updated_by);
CREATE TRIGGER trg_ai_agent_config_updated_at BEFORE UPDATE ON ai_agent_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Every saved prompt/config is kept so the editor can diff and roll back.
CREATE TABLE ai_agent_config_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ai_agent_config_id uuid NOT NULL REFERENCES ai_agent_config(id) ON DELETE CASCADE,
  version            integer NOT NULL,
  snapshot           jsonb NOT NULL,              -- full row at that version
  change_note        text,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_agent_config_versions_config_version UNIQUE (ai_agent_config_id, version)
);
CREATE INDEX idx_ai_agent_config_versions_tenant_id ON ai_agent_config_versions (tenant_id);
CREATE INDEX idx_ai_agent_config_versions_created_by ON ai_agent_config_versions (created_by);
CREATE INDEX idx_ai_agent_config_versions_created_at ON ai_agent_config_versions (created_at);

-- ── knowledge_snippets (FAQ the agent may quote: policies, inclusions) ──
CREATE TABLE knowledge_snippets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       text NOT NULL,
  content     text NOT NULL,
  tags        text[] NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  embedding   vector(384),                         -- optional semantic search
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_knowledge_snippets_tenant_id ON knowledge_snippets (tenant_id) WHERE is_active;
CREATE INDEX idx_knowledge_snippets_tags ON knowledge_snippets USING gin (tags);
CREATE TRIGGER trg_knowledge_snippets_updated_at BEFORE UPDATE ON knowledge_snippets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
