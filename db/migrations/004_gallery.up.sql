-- 004 Gallery: photos synced from the client's Google Drive folder (or zip import).
-- Design category, theme and price are parsed from folder/file names.
-- Only items with a proper descriptive name AND a price are sendable (decided 2026-11-08).

-- One row per unique file content (sha256). The same photo filed under two
-- folders = one asset, two items.
CREATE TABLE gallery_assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sha256              text NOT NULL,                -- of the ORIGINAL file bytes (dedupe key)
  storage_key         text NOT NULL,                -- MinIO object key of the normalised JPEG
  public_url          text NOT NULL,                -- what WhatsApp fetches
  mime_type           text NOT NULL DEFAULT 'image/jpeg',
  size_bytes          integer NOT NULL,
  width               integer,
  height              integer,
  original_mime_type  text,
  original_size_bytes integer,
  wa_media_id         text,                         -- cached Meta media id (optional fast path)
  wa_media_expires_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT uq_gallery_assets_tenant_sha256 UNIQUE (tenant_id, sha256),
  CONSTRAINT gallery_assets_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT gallery_assets_size_check CHECK (size_bytes > 0 AND size_bytes <= 5242880),  -- WhatsApp image limit
  CONSTRAINT gallery_assets_mime_check CHECK (mime_type = ANY (ARRAY['image/jpeg','image/png']))
);
CREATE INDEX idx_gallery_assets_tenant_id ON gallery_assets (tenant_id);
CREATE INDEX idx_gallery_assets_created_at ON gallery_assets (created_at);
CREATE TRIGGER trg_gallery_assets_updated_at BEFORE UPDATE ON gallery_assets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- One row per source placement (Drive file path). Sync writes only parsed_* and
-- source columns; override_* columns belong to admins and survive every re-sync.
CREATE TABLE gallery_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id             uuid NOT NULL REFERENCES gallery_assets(id) ON DELETE CASCADE,
  source               text NOT NULL,               -- drive | zip | upload
  source_path          text NOT NULL,               -- e.g. '2 frames decor/dinosour/Dinosaur Theme (10k-12k).jpeg'
  drive_file_id        text,
  drive_md5            text,
  drive_modified_at    timestamptz,
  -- parsed from names by the importer
  parsed_title         text,                        -- 'Dinosaur Theme'
  name_quality         text NOT NULL,               -- proper | price_only | generic
  parsed_package_id    uuid REFERENCES packages(id) ON DELETE SET NULL,
  parsed_theme_id      uuid REFERENCES themes(id) ON DELETE SET NULL,
  parsed_occasion_id   uuid REFERENCES occasions(id) ON DELETE SET NULL,
  parsed_style         text,                        -- ring | flex | simple | curtains | ...
  parsed_price_min     numeric(12,2),
  parsed_price_max     numeric(12,2),
  parsed_price_source  text NOT NULL DEFAULT 'none', -- filename | folder | none
  -- admin overrides (never touched by sync)
  override_title       text,
  override_package_id  uuid REFERENCES packages(id) ON DELETE SET NULL,
  override_theme_id    uuid REFERENCES themes(id) ON DELETE SET NULL,
  override_occasion_id uuid REFERENCES occasions(id) ON DELETE SET NULL,
  override_price_min   numeric(12,2),
  override_price_max   numeric(12,2),
  override_hidden      boolean NOT NULL DEFAULT false,
  override_force_sendable boolean NOT NULL DEFAULT false,  -- admin vouches for a generic-named photo
  override_updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  override_updated_at  timestamptz,
  -- effective values (what the bot uses)
  title          text GENERATED ALWAYS AS (COALESCE(override_title, parsed_title)) STORED,
  package_id     uuid GENERATED ALWAYS AS (COALESCE(override_package_id, parsed_package_id)) STORED,
  theme_id       uuid GENERATED ALWAYS AS (COALESCE(override_theme_id, parsed_theme_id)) STORED,
  occasion_id    uuid GENERATED ALWAYS AS (COALESCE(override_occasion_id, parsed_occasion_id)) STORED,
  price_min      numeric(12,2) GENERATED ALWAYS AS (COALESCE(override_price_min, parsed_price_min)) STORED,
  price_max      numeric(12,2) GENERATED ALWAYS AS (COALESCE(override_price_max, parsed_price_max)) STORED,
  is_present_in_source boolean NOT NULL DEFAULT true,  -- false when deleted from Drive
  is_sendable    boolean GENERATED ALWAYS AS (
    is_present_in_source
    AND NOT override_hidden
    AND (name_quality <> 'generic' OR override_force_sendable)
    AND COALESCE(override_price_min, parsed_price_min) IS NOT NULL
  ) STORED,
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_gallery_items_tenant_source_path UNIQUE (tenant_id, source, source_path),
  CONSTRAINT gallery_items_source_check CHECK (source = ANY (ARRAY['drive','zip','upload'])),
  CONSTRAINT gallery_items_name_quality_check CHECK (name_quality = ANY (ARRAY['proper','price_only','generic'])),
  CONSTRAINT gallery_items_price_source_check CHECK (parsed_price_source = ANY (ARRAY['filename','folder','none'])),
  CONSTRAINT gallery_items_parsed_price_check CHECK (
    (parsed_price_min IS NULL AND parsed_price_max IS NULL)
    OR (parsed_price_min >= 0 AND parsed_price_max >= parsed_price_min)),
  CONSTRAINT gallery_items_override_price_check CHECK (
    (override_price_min IS NULL AND override_price_max IS NULL)
    OR (override_price_min >= 0 AND override_price_max >= override_price_min)),
  CONSTRAINT gallery_items_price_source_consistency CHECK (
    (parsed_price_source = 'none') = (parsed_price_min IS NULL))
);
CREATE INDEX idx_gallery_items_tenant_id ON gallery_items (tenant_id);
CREATE INDEX idx_gallery_items_asset_id ON gallery_items (asset_id);
CREATE INDEX idx_gallery_items_parsed_package_id ON gallery_items (parsed_package_id);
CREATE INDEX idx_gallery_items_parsed_theme_id ON gallery_items (parsed_theme_id);
CREATE INDEX idx_gallery_items_parsed_occasion_id ON gallery_items (parsed_occasion_id);
CREATE INDEX idx_gallery_items_override_package_id ON gallery_items (override_package_id);
CREATE INDEX idx_gallery_items_override_theme_id ON gallery_items (override_theme_id);
CREATE INDEX idx_gallery_items_override_occasion_id ON gallery_items (override_occasion_id);
CREATE INDEX idx_gallery_items_override_updated_by ON gallery_items (override_updated_by);
CREATE INDEX idx_gallery_items_drive_file_id ON gallery_items (drive_file_id) WHERE drive_file_id IS NOT NULL;
CREATE INDEX idx_gallery_items_created_at ON gallery_items (created_at);
-- the bot's lookup: sendable photos by theme / package within a budget
CREATE INDEX idx_gallery_items_sendable_theme ON gallery_items (tenant_id, theme_id, price_min) WHERE is_sendable;
CREATE INDEX idx_gallery_items_sendable_package ON gallery_items (tenant_id, package_id, price_min) WHERE is_sendable;
CREATE INDEX idx_gallery_items_sendable_price ON gallery_items (tenant_id, price_min, price_max) WHERE is_sendable;
CREATE TRIGGER trg_gallery_items_updated_at BEFORE UPDATE ON gallery_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Each sync/import run with its report (unpriced, generic names, errors).
CREATE TABLE gallery_sync_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source       text NOT NULL,
  status       text NOT NULL DEFAULT 'running',
  triggered_by uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = cron
  stats        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {seen, added, updated, removed, sendable, generic, unpriced}
  report       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {generic:[paths], unpriced:[paths], errors:[...]}
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gallery_sync_runs_source_check CHECK (source = ANY (ARRAY['drive','zip','upload'])),
  CONSTRAINT gallery_sync_runs_status_check CHECK (status = ANY (ARRAY['running','succeeded','failed','partial']))
);
CREATE INDEX idx_gallery_sync_runs_tenant_id ON gallery_sync_runs (tenant_id);
CREATE INDEX idx_gallery_sync_runs_triggered_by ON gallery_sync_runs (triggered_by);
CREATE INDEX idx_gallery_sync_runs_created_at ON gallery_sync_runs (created_at);
-- at most one running sync per tenant
CREATE UNIQUE INDEX uq_gallery_sync_runs_one_running ON gallery_sync_runs (tenant_id) WHERE status = 'running';
