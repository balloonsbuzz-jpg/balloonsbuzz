DROP INDEX IF EXISTS idx_messages_gallery_item;
DROP INDEX IF EXISTS uq_leads_open_per_conversation;
DELETE FROM conversations WHERE is_sandbox;
DELETE FROM contacts WHERE source = 'sandbox';
DROP INDEX IF EXISTS idx_conversations_sandbox;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_account_check;
ALTER TABLE conversations ALTER COLUMN whatsapp_account_id SET NOT NULL;
ALTER TABLE conversations DROP COLUMN IF EXISTS is_sandbox;
ALTER TABLE contacts DROP CONSTRAINT contacts_source_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_source_check
  CHECK (source = ANY (ARRAY['whatsapp','manual','import','website','ad']));
