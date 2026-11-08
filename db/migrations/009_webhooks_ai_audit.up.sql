-- 009 Raw webhook log (idempotency), AI run + tool call logs, audit log.

-- Written by the webhook endpoint BEFORE acking Meta. event_key is derived from
-- the payload (message id / status id+status / sha256 of body) so retries from
-- Meta hit ON CONFLICT DO NOTHING and are never processed twice.
CREATE TABLE webhook_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL until routed by phone_number_id
  source           text NOT NULL DEFAULT 'whatsapp',
  event_key        text NOT NULL,
  event_type       text NOT NULL,                  -- message | status | template_status | unknown
  phone_number_id  text,
  payload          jsonb NOT NULL,
  signature_valid  boolean NOT NULL,
  status           text NOT NULL DEFAULT 'received',
  attempts         integer NOT NULL DEFAULT 0,
  error_message    text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_webhook_events_source_event_key UNIQUE (source, event_key),
  CONSTRAINT webhook_events_source_check CHECK (source = ANY (ARRAY['whatsapp','gdrive','payment'])),
  CONSTRAINT webhook_events_status_check CHECK (status = ANY (ARRAY['received','queued','processing','processed','failed','ignored'])),
  CONSTRAINT webhook_events_attempts_check CHECK (attempts >= 0)
);
CREATE INDEX idx_webhook_events_tenant_id ON webhook_events (tenant_id);
CREATE INDEX idx_webhook_events_status ON webhook_events (status, received_at) WHERE status IN ('received','queued','failed');
CREATE INDEX idx_webhook_events_created_at ON webhook_events (created_at);

-- One row per agent turn (LLM call loop) -> cost, latency and outcome analytics.
CREATE TABLE ai_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  trigger_message_id  uuid REFERENCES messages(id) ON DELETE SET NULL,
  ai_agent_config_version integer,
  provider            text NOT NULL,
  model               text NOT NULL,
  input_tokens        integer NOT NULL DEFAULT 0,
  output_tokens       integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  cost_inr            numeric(12,4) NOT NULL DEFAULT 0,
  latency_ms          integer,
  iterations          integer NOT NULL DEFAULT 0,
  outcome             text NOT NULL DEFAULT 'running',
  blocked_reason      text,                         -- outbound guard: e.g. 'unknown_price:7500'
  error_message       text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_runs_outcome_check CHECK (outcome = ANY (ARRAY[
    'running','replied','handover','blocked','skipped_human','skipped_disabled','error'])),
  CONSTRAINT ai_runs_tokens_check CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cached_input_tokens >= 0 AND cost_inr >= 0)
);
CREATE INDEX idx_ai_runs_tenant_id ON ai_runs (tenant_id);
CREATE INDEX idx_ai_runs_conversation_id ON ai_runs (conversation_id, created_at DESC);
CREATE INDEX idx_ai_runs_trigger_message_id ON ai_runs (trigger_message_id);
CREATE INDEX idx_ai_runs_outcome ON ai_runs (tenant_id, outcome, created_at);
CREATE INDEX idx_ai_runs_created_at ON ai_runs (created_at);

ALTER TABLE messages
  ADD CONSTRAINT messages_ai_run_id_fkey FOREIGN KEY (ai_run_id) REFERENCES ai_runs(id) ON DELETE SET NULL;

CREATE TABLE ai_tool_calls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ai_run_id    uuid NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  tool_name    text NOT NULL,
  arguments    jsonb NOT NULL DEFAULT '{}'::jsonb,
  result       jsonb,
  success      boolean NOT NULL,
  error_message text,
  duration_ms  integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_tool_calls_tool_check CHECK (tool_name ~ '^[a-z_]{2,64}$')
);
CREATE INDEX idx_ai_tool_calls_tenant_id ON ai_tool_calls (tenant_id);
CREATE INDEX idx_ai_tool_calls_ai_run_id ON ai_tool_calls (ai_run_id);
CREATE INDEX idx_ai_tool_calls_tool_name ON ai_tool_calls (tenant_id, tool_name, created_at);
CREATE INDEX idx_ai_tool_calls_created_at ON ai_tool_calls (created_at);

-- Append-only audit trail: settings/price/rule edits, discounts granted, handovers, logins.
CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type    text NOT NULL,                     -- user | bot | system
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action        text NOT NULL,                     -- e.g. 'negotiation_rule.update', 'booking.status_change'
  entity_type   text NOT NULL,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_actor_check CHECK (actor_type = ANY (ARRAY['user','bot','system'])),
  CONSTRAINT audit_log_action_check CHECK (action ~ '^[a-z_]+\.[a-z_]+$')
);
CREATE INDEX idx_audit_log_tenant_created ON audit_log (tenant_id, created_at DESC);
CREATE INDEX idx_audit_log_actor_user_id ON audit_log (actor_user_id);
CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_log_created_at ON audit_log (created_at);

-- audit_log is append-only: block UPDATE/DELETE (tenant deletion still cascades via TRUNCATE-free FK path).
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;  -- allow cascade when the tenant itself is removed
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL
     AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
    RETURN NEW;  -- allow ON DELETE SET NULL when a user row is removed
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
CREATE TRIGGER trg_audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
