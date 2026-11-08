-- 008 Fixed automations (event -> action) and scheduled follow-ups (BullMQ delayed jobs).

CREATE TABLE automations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key            text NOT NULL,
  name           text NOT NULL,
  trigger_type   text NOT NULL,
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"delay_minutes":180} or {"offset_hours":-24}
  action_type    text NOT NULL,
  action_config  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"text":"..."} or {"template_purpose":"event_reminder"}
  only_when_bot  boolean NOT NULL DEFAULT true,        -- skip while a human is handling the chat
  is_active      boolean NOT NULL DEFAULT false,
  run_count      integer NOT NULL DEFAULT 0,
  last_run_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_automations_tenant_key UNIQUE (tenant_id, key),
  CONSTRAINT automations_trigger_check CHECK (trigger_type = ANY (ARRAY[
    'first_inbound','keyword','quote_no_reply','advance_pending','booking_confirmed',
    'event_reminder','post_event_review','lead_stale','handover_requested'])),
  CONSTRAINT automations_action_check CHECK (action_type = ANY (ARRAY[
    'send_text','send_template','notify_staff','add_tag','set_lead_status']))
);
CREATE INDEX idx_automations_tenant_trigger ON automations (tenant_id, trigger_type) WHERE is_active;
CREATE TRIGGER trg_automations_updated_at BEFORE UPDATE ON automations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE followups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  booking_id      uuid REFERENCES bookings(id) ON DELETE CASCADE,
  automation_id   uuid REFERENCES automations(id) ON DELETE SET NULL,
  kind            text NOT NULL,                   -- mirrors automations.trigger_type, or 'agent_scheduled' / 'bot_scheduled'
  idempotency_key text NOT NULL,                   -- e.g. 'event_reminder:<booking_id>' so cron never double-sends
  scheduled_at    timestamptz NOT NULL,
  content         jsonb NOT NULL,                  -- {"type":"text","text":"..."} | {"type":"template","template_id":..,"variables":{}}
  cancel_on_reply boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'pending',
  job_id          text,                            -- BullMQ job id
  attempts        integer NOT NULL DEFAULT 0,
  message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  error_message   text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at         timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_followups_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT followups_status_check CHECK (status = ANY (ARRAY['pending','sent','cancelled','failed','skipped'])),
  CONSTRAINT followups_content_check CHECK (content ? 'type'),
  CONSTRAINT followups_attempts_check CHECK (attempts >= 0)
);
CREATE INDEX idx_followups_tenant_id ON followups (tenant_id);
CREATE INDEX idx_followups_contact_pending ON followups (contact_id) WHERE status = 'pending';
CREATE INDEX idx_followups_conversation_id ON followups (conversation_id);
CREATE INDEX idx_followups_lead_id ON followups (lead_id);
CREATE INDEX idx_followups_booking_id ON followups (booking_id);
CREATE INDEX idx_followups_automation_id ON followups (automation_id);
CREATE INDEX idx_followups_message_id ON followups (message_id);
CREATE INDEX idx_followups_created_by ON followups (created_by);
CREATE INDEX idx_followups_due ON followups (scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_followups_created_at ON followups (created_at);
CREATE TRIGGER trg_followups_updated_at BEFORE UPDATE ON followups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
