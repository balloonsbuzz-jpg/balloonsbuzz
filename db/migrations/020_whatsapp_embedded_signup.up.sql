-- 020 Connect a number with Meta's Embedded Signup: a new number, or coexistence (the number
-- stays in the WhatsApp Business app on the phone and is used here too).
ALTER TABLE whatsapp_accounts
  ADD COLUMN connection_type         text NOT NULL DEFAULT 'manual',   -- manual | embedded
  ADD COLUMN is_coexistence          boolean NOT NULL DEFAULT false,
  ADD COLUMN two_step_pin_enc        text,                             -- PIN we registered the number with
  ADD COLUMN setup_steps             jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{key, ok, error}] of the last setup run
  ADD COLUMN connected_at            timestamptz,
  -- coexistence imports (Meta allows each one once per onboarding)
  ADD COLUMN contacts_sync_status    text,
  ADD COLUMN contacts_sync_request_id text,
  ADD COLUMN history_sync_status     text,
  ADD COLUMN history_sync_request_id text,
  ADD COLUMN history_sync_progress   smallint,
  ADD CONSTRAINT whatsapp_accounts_connection_type_check CHECK (connection_type = ANY (ARRAY['manual','embedded'])),
  ADD CONSTRAINT whatsapp_accounts_contacts_sync_check CHECK (contacts_sync_status IS NULL OR contacts_sync_status = ANY (ARRAY['requested','syncing','completed','failed','declined'])),
  ADD CONSTRAINT whatsapp_accounts_history_sync_check CHECK (history_sync_status IS NULL OR history_sync_status = ANY (ARRAY['requested','syncing','completed','failed','declined'])),
  ADD CONSTRAINT whatsapp_accounts_history_progress_check CHECK (history_sync_progress IS NULL OR history_sync_progress BETWEEN 0 AND 100);
