-- 019 One-time links to set a password: invites for new team members and admin-issued
-- resets. There is no email system, so the owner sends the link (e.g. on WhatsApp).
-- Only the SHA-256 of the token is stored; a link works once and expires.
CREATE TABLE password_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_password_tokens_token_hash UNIQUE (token_hash),
  CONSTRAINT password_tokens_purpose_check CHECK (purpose = ANY (ARRAY['invite','reset'])),
  CONSTRAINT password_tokens_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX idx_password_tokens_tenant_id ON password_tokens (tenant_id);
CREATE INDEX idx_password_tokens_user_id ON password_tokens (user_id);
CREATE INDEX idx_password_tokens_created_by ON password_tokens (created_by);
CREATE INDEX idx_password_tokens_created_at ON password_tokens (created_at);
ALTER TABLE password_tokens ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON password_tokens FROM anon, authenticated';
  END IF;
END $$;
