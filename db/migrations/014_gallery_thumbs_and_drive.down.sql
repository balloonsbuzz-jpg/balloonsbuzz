DROP INDEX IF EXISTS idx_gallery_items_tenant_quality;
DROP INDEX IF EXISTS uq_gallery_items_tenant_drive_file;
ALTER TABLE gallery_assets DROP COLUMN IF EXISTS thumb_url, DROP COLUMN IF EXISTS thumb_storage_key;
-- the 'celebrate' alias is left on occasions (harmless)
