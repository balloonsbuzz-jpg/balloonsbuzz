-- 005 Contacts, tags, notes, conversations (single handover state), messages, media,
--     handover_events, canned replies.
-- One conversations table and one messages table (Whapter kept three in sync).

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone           text NOT NULL,                  -- digits, E.164 without '+', e.g. 919392534625
  wa_id           text,                           -- WhatsApp id from webhook (normally = phone)
  name            text,                           -- profile name from WhatsApp or edited
  email           text,
  preferred_language text,
  source          text NOT NULL DEFAULT 'whatsapp',
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,   -- e.g. ad referral (ctwa_clid)
  opted_in        boolean NOT NULL DEFAULT true,  -- marketing broadcasts allowed
  opted_out_at    timestamptz,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  last_inbound_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT contacts_phone_check CHECK (phone ~ '^[1-9][0-9]{7,14}$'),
  CONSTRAINT contacts_source_check CHECK (source = ANY (ARRAY['whatsapp','manual','import','website','ad'])),
  CONSTRAINT contacts_opt_out_check CHECK (opted_in OR opted_out_at IS NOT NULL)
);
CREATE UNIQUE INDEX uq_contacts_tenant_phone ON contacts (tenant_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX idx_contacts_tenant_id ON contacts (tenant_id);
CREATE INDEX idx_contacts_phone ON contacts (phone);
CREATE INDEX idx_contacts_assigned_user_id ON contacts (assigned_user_id);
CREATE INDEX idx_contacts_created_at ON contacts (created_at);
CREATE INDEX idx_contacts_tenant_lower_name ON contacts (tenant_id, lower(name));
CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE tags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text NOT NULL DEFAULT '#9CA3AF',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_color_check CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
);
CREATE UNIQUE INDEX uq_tags_tenant_name ON tags (tenant_id, lower(name));
CREATE INDEX idx_tags_tenant_id ON tags (tenant_id);
CREATE TRIGGER trg_tags_updated_at BEFORE UPDATE ON tags
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE contact_tags (
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  added_by    uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = bot/automation
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX idx_contact_tags_tag_id ON contact_tags (tag_id);
CREATE INDEX idx_contact_tags_tenant_id ON contact_tags (tenant_id);
CREATE INDEX idx_contact_tags_added_by ON contact_tags (added_by);

CREATE TABLE contact_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contact_notes_tenant_id ON contact_notes (tenant_id);
CREATE INDEX idx_contact_notes_contact_id ON contact_notes (contact_id);
CREATE INDEX idx_contact_notes_author_id ON contact_notes (author_id);
CREATE INDEX idx_contact_notes_created_at ON contact_notes (created_at);
CREATE TRIGGER trg_contact_notes_updated_at BEFORE UPDATE ON contact_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── media: inbound customer media + agent uploads (gallery has its own tables) ──
CREATE TABLE media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source        text NOT NULL,                    -- inbound | upload
  storage_key   text,                             -- NULL until downloaded from Meta
  public_url    text,
  mime_type     text NOT NULL,
  size_bytes    integer,
  sha256        text,
  wa_media_id   text,
  original_filename text,
  download_status text NOT NULL DEFAULT 'pending', -- pending | stored | failed
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_source_check CHECK (source = ANY (ARRAY['inbound','upload'])),
  CONSTRAINT media_download_status_check CHECK (download_status = ANY (ARRAY['pending','stored','failed'])),
  CONSTRAINT media_size_check CHECK (size_bytes IS NULL OR size_bytes >= 0)
);
CREATE INDEX idx_media_tenant_id ON media (tenant_id);
CREATE INDEX idx_media_uploaded_by ON media (uploaded_by);
CREATE INDEX idx_media_wa_media_id ON media (wa_media_id) WHERE wa_media_id IS NOT NULL;
CREATE INDEX idx_media_created_at ON media (created_at);

-- ── conversations: one thread per contact per WhatsApp number ──
CREATE TABLE conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  whatsapp_account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'open',   -- open | pending | closed
  -- the ONE handover state (Whapter split this across two tables)
  handling_mode       text NOT NULL DEFAULT 'bot',    -- bot | human | paused
  needs_human         boolean NOT NULL DEFAULT false, -- in the "needs human" queue, not yet picked up
  handover_reason     text,
  handover_at         timestamptz,
  bot_resume_at       timestamptz,                    -- optional auto-resume
  assigned_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  -- inbox list / 24h window
  last_inbound_at     timestamptz,                    -- customer-service window = last_inbound_at + 24h
  last_message_at     timestamptz,
  last_message_preview text,
  last_message_direction text,
  unread_count        integer NOT NULL DEFAULT 0,
  -- AI memory
  summary             text,
  summary_message_count integer NOT NULL DEFAULT 0,
  bot_stuck_count     integer NOT NULL DEFAULT 0,     -- consecutive failed/confused turns
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_conversations_contact_account UNIQUE (tenant_id, contact_id, whatsapp_account_id),
  CONSTRAINT conversations_status_check CHECK (status = ANY (ARRAY['open','pending','closed'])),
  CONSTRAINT conversations_handling_mode_check CHECK (handling_mode = ANY (ARRAY['bot','human','paused'])),
  CONSTRAINT conversations_direction_check CHECK (last_message_direction IS NULL OR last_message_direction = ANY (ARRAY['inbound','outbound'])),
  CONSTRAINT conversations_unread_check CHECK (unread_count >= 0),
  CONSTRAINT conversations_handover_check CHECK (handling_mode = 'bot' OR handover_at IS NOT NULL)
);
CREATE INDEX idx_conversations_tenant_id ON conversations (tenant_id);
CREATE INDEX idx_conversations_contact_id ON conversations (contact_id);
CREATE INDEX idx_conversations_whatsapp_account_id ON conversations (whatsapp_account_id);
CREATE INDEX idx_conversations_assigned_user_id ON conversations (assigned_user_id);
CREATE INDEX idx_conversations_status ON conversations (tenant_id, status, last_message_at DESC);
CREATE INDEX idx_conversations_handling_mode ON conversations (tenant_id, handling_mode, last_message_at DESC);
CREATE INDEX idx_conversations_needs_human ON conversations (tenant_id, handover_at) WHERE needs_human;
CREATE INDEX idx_conversations_bot_resume_at ON conversations (bot_resume_at) WHERE bot_resume_at IS NOT NULL;
CREATE INDEX idx_conversations_created_at ON conversations (created_at);
CREATE TRIGGER trg_conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── messages ─────────────────────────────────────────────────
CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction           text NOT NULL,                -- inbound | outbound
  sender_type         text NOT NULL,                -- customer | bot | agent | system
  sender_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  message_type        text NOT NULL,
  body                text,                         -- text / caption
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- interactive, location, template params, raw extras
  media_id            uuid REFERENCES media(id) ON DELETE SET NULL,
  gallery_item_id     uuid REFERENCES gallery_items(id) ON DELETE SET NULL,  -- photo sent from gallery
  wa_message_id       text,                         -- wamid.*
  reply_to_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  status              text NOT NULL,
  error_code          text,
  error_message       text,
  retry_count         integer NOT NULL DEFAULT 0,
  ai_run_id           uuid,                         -- FK added in 009
  is_internal_note    boolean NOT NULL DEFAULT false,   -- agent note, never sent
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_direction_check CHECK (direction = ANY (ARRAY['inbound','outbound'])),
  CONSTRAINT messages_sender_type_check CHECK (sender_type = ANY (ARRAY['customer','bot','agent','system'])),
  CONSTRAINT messages_direction_sender_check CHECK (
    (direction = 'inbound' AND sender_type = 'customer') OR (direction = 'outbound' AND sender_type <> 'customer')),
  CONSTRAINT messages_type_check CHECK (message_type = ANY (ARRAY[
    'text','image','video','audio','document','sticker','location','contacts',
    'interactive','button','template','reaction','order','system','unsupported'])),
  CONSTRAINT messages_status_check CHECK (status = ANY (ARRAY[
    'received','queued','sending','sent','delivered','read','failed','cancelled'])),
  CONSTRAINT messages_retry_check CHECK (retry_count >= 0)
);
-- DB-level idempotency for inbound + status updates (Whapter relied on Redis only)
CREATE UNIQUE INDEX uq_messages_tenant_wa_message_id ON messages (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX idx_messages_tenant_id ON messages (tenant_id);
CREATE INDEX idx_messages_conversation_created ON messages (conversation_id, created_at DESC);
CREATE INDEX idx_messages_contact_id ON messages (contact_id);
CREATE INDEX idx_messages_sender_user_id ON messages (sender_user_id);
CREATE INDEX idx_messages_media_id ON messages (media_id);
CREATE INDEX idx_messages_gallery_item_id ON messages (gallery_item_id);
CREATE INDEX idx_messages_reply_to_message_id ON messages (reply_to_message_id);
CREATE INDEX idx_messages_ai_run_id ON messages (ai_run_id);
CREATE INDEX idx_messages_created_at ON messages (created_at);
CREATE INDEX idx_messages_failed ON messages (tenant_id, created_at) WHERE status = 'failed';

-- ── handover_events: full history of who switched bot/human and why ──
CREATE TABLE handover_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_mode       text NOT NULL,
  to_mode         text NOT NULL,
  trigger         text NOT NULL,
  reason          text,
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = bot/system
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,              -- e.g. {requested_price, floor_price}
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handover_events_modes_check CHECK (
    from_mode = ANY (ARRAY['bot','human','paused']) AND to_mode = ANY (ARRAY['bot','human','paused']) AND from_mode <> to_mode),
  CONSTRAINT handover_events_trigger_check CHECK (trigger = ANY (ARRAY[
    'customer_request','keyword','discount_limit','bot_stuck','out_of_area','date_unavailable',
    'agent_takeover','agent_pause','agent_resume','auto_resume','agent_reply','system']))
);
CREATE INDEX idx_handover_events_tenant_id ON handover_events (tenant_id);
CREATE INDEX idx_handover_events_conversation_id ON handover_events (conversation_id, created_at DESC);
CREATE INDEX idx_handover_events_actor_user_id ON handover_events (actor_user_id);
CREATE INDEX idx_handover_events_created_at ON handover_events (created_at);

-- ── canned_replies (Whapter: crm_canned_messages) ────────────
CREATE TABLE canned_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shortcut    text NOT NULL,                      -- typed as /shortcut in the composer
  title       text NOT NULL,
  body        text NOT NULL,
  use_count   integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_canned_replies_tenant_shortcut UNIQUE (tenant_id, shortcut),
  CONSTRAINT canned_replies_shortcut_check CHECK (shortcut ~ '^[a-z0-9_-]{1,30}$')
);
CREATE INDEX idx_canned_replies_created_by ON canned_replies (created_by);
CREATE TRIGGER trg_canned_replies_updated_at BEFORE UPDATE ON canned_replies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
