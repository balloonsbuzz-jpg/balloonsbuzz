-- 001 Foundation: extensions, shared trigger, tenants, roles, users, sessions
-- Conventions (mirroring Whapter): uuid PKs via gen_random_uuid(), timestamptz
-- created_at/updated_at kept by trigger, text + CHECK instead of native enums,
-- jsonb for flexible config, tenant_id -> tenants(id) ON DELETE CASCADE,
-- idx_<table>_<cols> / uq_<table>_<cols> naming, deleted_at only where history matters.

CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector (optional embeddings)
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraint on distance slabs

CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── tenants ───────────────────────────────────────────────────
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL,
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Kolkata',
  currency    text NOT NULL DEFAULT 'INR',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tenants_slug UNIQUE (slug),
  CONSTRAINT tenants_slug_check CHECK (slug ~ '^[a-z0-9-]{2,50}$'),
  CONSTRAINT tenants_currency_check CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE TRIGGER trg_tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── roles (Whapter: workspace_roles with permissions jsonb) ──
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,   -- array of permission keys, e.g. ["inbox:read","settings:write"]
  is_system   boolean NOT NULL DEFAULT false,       -- owner/admin/agent cannot be deleted
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_roles_tenant_key UNIQUE (tenant_id, key),
  CONSTRAINT roles_permissions_check CHECK (jsonb_typeof(permissions) = 'array')
);
CREATE INDEX idx_roles_tenant_id ON roles (tenant_id);
CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── users ─────────────────────────────────────────────────────
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role_id            uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  full_name          text NOT NULL,
  email              text NOT NULL,
  phone              text,                         -- digits only, E.164 without '+', for staff alerts
  password_hash      text,                         -- bcrypt; NULL until invite accepted
  is_active          boolean NOT NULL DEFAULT true,
  last_login_at      timestamptz,
  password_changed_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT users_email_check CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT users_phone_check CHECK (phone IS NULL OR phone ~ '^[1-9][0-9]{7,14}$')
);
CREATE UNIQUE INDEX uq_users_tenant_email ON users (tenant_id, email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_tenant_id ON users (tenant_id);
CREATE INDEX idx_users_role_id ON users (role_id);
CREATE INDEX idx_users_created_at ON users (created_at);
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── sessions (refresh tokens; only the hash is stored) ───────
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL,
  user_agent         text,
  ip                 inet,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sessions_refresh_token_hash UNIQUE (refresh_token_hash)
);
CREATE INDEX idx_sessions_tenant_id ON sessions (tenant_id);
CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
CREATE INDEX idx_sessions_created_at ON sessions (created_at);
