-- 014 Gallery import (M5): thumbnails for the dashboard grid and one row per Drive file.

ALTER TABLE gallery_assets
  ADD COLUMN thumb_storage_key text,
  ADD COLUMN thumb_url text;

-- A Drive file keeps its id when renamed or moved, so the id (not the path) identifies it.
CREATE UNIQUE INDEX uq_gallery_items_tenant_drive_file
  ON gallery_items (tenant_id, drive_file_id) WHERE source = 'drive' AND drive_file_id IS NOT NULL;

-- Admin "photo picker" filters
CREATE INDEX idx_gallery_items_tenant_quality ON gallery_items (tenant_id, name_quality);

-- Photo names say "Celebrate Theme"; new installs get this from seed 003.
UPDATE occasions SET aliases = array_append(aliases, 'celebrate')
 WHERE key = 'congratulations' AND deleted_at IS NULL AND NOT ('celebrate' = ANY (aliases));
