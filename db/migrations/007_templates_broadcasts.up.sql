-- 007 WhatsApp message templates (Meta-synced) and broadcasts.

CREATE TABLE templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  name                text NOT NULL,
  language            text NOT NULL DEFAULT 'en',
  category            text NOT NULL,
  status              text NOT NULL DEFAULT 'draft',
  components          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- Meta template components
  variable_map        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"1":"contact.name","2":"booking.event_date"}
  meta_template_id    text,
  rejected_reason     text,
  purpose             text,                       -- internal: booking_confirmation | event_reminder | review_request | broadcast | handover_alert ...
  last_synced_at      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_templates_account_name_language UNIQUE (whatsapp_account_id, name, language),
  CONSTRAINT templates_name_check CHECK (name ~ '^[a-z0-9_]{1,512}$'),
  CONSTRAINT templates_category_check CHECK (category = ANY (ARRAY['MARKETING','UTILITY','AUTHENTICATION'])),
  CONSTRAINT templates_status_check CHECK (status = ANY (ARRAY['draft','pending','approved','rejected','paused','disabled'])),
  CONSTRAINT templates_components_check CHECK (jsonb_typeof(components) = 'array')
);
CREATE INDEX idx_templates_tenant_id ON templates (tenant_id);
CREATE INDEX idx_templates_whatsapp_account_id ON templates (whatsapp_account_id);
CREATE INDEX idx_templates_status ON templates (tenant_id, status);
CREATE INDEX idx_templates_purpose ON templates (tenant_id, purpose) WHERE purpose IS NOT NULL;
CREATE TRIGGER trg_templates_updated_at BEFORE UPDATE ON templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE broadcasts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  template_id         uuid NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  name                text NOT NULL,
  variables           jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience_filter     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"tags_any":[...],"occasion":"birthday","last_booking_before":"2026-01-01"}
  status              text NOT NULL DEFAULT 'draft',
  scheduled_at        timestamptz,
  started_at          timestamptz,
  completed_at        timestamptz,
  total_count         integer NOT NULL DEFAULT 0,
  sent_count          integer NOT NULL DEFAULT 0,
  delivered_count     integer NOT NULL DEFAULT 0,
  read_count          integer NOT NULL DEFAULT 0,
  replied_count       integer NOT NULL DEFAULT 0,
  failed_count        integer NOT NULL DEFAULT 0,
  skipped_count       integer NOT NULL DEFAULT 0,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT broadcasts_status_check CHECK (status = ANY (ARRAY['draft','scheduled','running','paused','completed','cancelled','failed'])),
  CONSTRAINT broadcasts_scheduled_check CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL),
  CONSTRAINT broadcasts_counts_check CHECK (
    total_count >= 0 AND sent_count >= 0 AND delivered_count >= 0 AND read_count >= 0
    AND replied_count >= 0 AND failed_count >= 0 AND skipped_count >= 0)
);
CREATE INDEX idx_broadcasts_tenant_id ON broadcasts (tenant_id);
CREATE INDEX idx_broadcasts_whatsapp_account_id ON broadcasts (whatsapp_account_id);
CREATE INDEX idx_broadcasts_template_id ON broadcasts (template_id);
CREATE INDEX idx_broadcasts_created_by ON broadcasts (created_by);
CREATE INDEX idx_broadcasts_status ON broadcasts (tenant_id, status);
CREATE INDEX idx_broadcasts_scheduled_at ON broadcasts (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX idx_broadcasts_created_at ON broadcasts (created_at);
CREATE TRIGGER trg_broadcasts_updated_at BEFORE UPDATE ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE broadcast_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  broadcast_id  uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  contact_id    uuid REFERENCES contacts(id) ON DELETE SET NULL,
  phone         text NOT NULL,
  variables     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- resolved per-recipient values
  status        text NOT NULL DEFAULT 'pending',
  message_id    uuid REFERENCES messages(id) ON DELETE SET NULL,
  wa_message_id text,
  error_code    text,
  error_message text,
  attempts      integer NOT NULL DEFAULT 0,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  read_at       timestamptz,
  replied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_broadcast_recipients_broadcast_phone UNIQUE (broadcast_id, phone),
  CONSTRAINT broadcast_recipients_status_check CHECK (status = ANY (ARRAY['pending','queued','sent','delivered','read','failed','skipped'])),
  CONSTRAINT broadcast_recipients_phone_check CHECK (phone ~ '^[1-9][0-9]{7,14}$'),
  CONSTRAINT broadcast_recipients_attempts_check CHECK (attempts >= 0)
);
CREATE INDEX idx_broadcast_recipients_tenant_id ON broadcast_recipients (tenant_id);
CREATE INDEX idx_broadcast_recipients_broadcast_status ON broadcast_recipients (broadcast_id, status);
CREATE INDEX idx_broadcast_recipients_contact_id ON broadcast_recipients (contact_id);
CREATE INDEX idx_broadcast_recipients_message_id ON broadcast_recipients (message_id);
CREATE INDEX idx_broadcast_recipients_phone ON broadcast_recipients (phone);
CREATE UNIQUE INDEX uq_broadcast_recipients_wa_message_id ON broadcast_recipients (wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX idx_broadcast_recipients_created_at ON broadcast_recipients (created_at);
CREATE TRIGGER trg_broadcast_recipients_updated_at BEFORE UPDATE ON broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
