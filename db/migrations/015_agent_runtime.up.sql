-- 015 AI agent runtime (M6): sandbox chats for the test console, one open lead per
-- conversation, and the tool parameter schemas the runtime now owns.

-- Test console: a sandbox conversation runs the real agent + tools but never reaches WhatsApp.
ALTER TABLE contacts DROP CONSTRAINT contacts_source_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_source_check
  CHECK (source = ANY (ARRAY['whatsapp','manual','import','website','ad','sandbox']));

ALTER TABLE conversations ADD COLUMN is_sandbox boolean NOT NULL DEFAULT false;
ALTER TABLE conversations ALTER COLUMN whatsapp_account_id DROP NOT NULL;
ALTER TABLE conversations ADD CONSTRAINT conversations_account_check
  CHECK (is_sandbox OR whatsapp_account_id IS NOT NULL);
CREATE INDEX idx_conversations_sandbox ON conversations (tenant_id) WHERE is_sandbox;

-- The agent keeps one open lead per conversation (won/lost leads are history).
CREATE UNIQUE INDEX uq_leads_open_per_conversation ON leads (conversation_id)
  WHERE deleted_at IS NULL AND status NOT IN ('won','lost') AND conversation_id IS NOT NULL;

CREATE INDEX idx_messages_gallery_item ON messages (conversation_id, gallery_item_id) WHERE gallery_item_id IS NOT NULL;

-- Tool parameters are defined in code (backend/src/agent/tools/definitions.js); keep the
-- displayed copy in sync for the tools whose arguments changed.
UPDATE ai_tools SET parameters = '{"type":"object","properties":{"package_key":{"type":"string","description":"Design category key from the context list, e.g. two_frames"},"photo_id":{"type":"string","description":"id of a photo already sent, when the customer picked one"},"theme":{"type":"string"},"occasion":{"type":"string"},"addons":{"type":"array","items":{"type":"object","properties":{"package_key":{"type":"string"},"quantity":{"type":"integer","minimum":1}},"required":["package_key"]}}}}'::jsonb
 WHERE name = 'get_pricing';
