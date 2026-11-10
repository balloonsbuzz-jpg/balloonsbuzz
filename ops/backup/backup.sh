#!/bin/sh
# One backup run: database dump (encrypted) + gallery photo mirror + pruning.
. /ops/lib.sh
need_passphrase
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set"
URL=$(pg_url "$DATABASE_URL")
KEEP="${BACKUP_KEEP_DAYS:-14}"
mkdir -p /backups/db /backups/gallery

ts=$(date -u +%Y%m%dT%H%M%SZ)
out="/backups/db/bb-${ts}.dump.enc"
log "dumping database"
# Only the app's schema (+ the two extensions it uses); Supabase backs up its own schemas.
if ! pg_dump "$URL" --format=custom --schema=public --extension=vector --extension=btree_gist \
     --no-owner --no-privileges | encrypt > "${out}.part"; then
  rm -f "${out}.part"
  die "pg_dump failed"
fi
mv "${out}.part" "$out"
(cd /backups/db && sha256sum "$(basename "$out")" > "$(basename "$out").sha256")
log "database saved: $(basename "$out") ($(du -h "$out" | cut -f1))"

# Gallery: download any photo/thumbnail we don't have yet. File names are content hashes, so
# an existing file never changes. Drive stays the original source; this is the second copy.
if [ "${BACKUP_GALLERY:-true}" = "true" ]; then
  psql "$URL" -At -F ' ' -c "SELECT storage_key, public_url FROM gallery_assets WHERE deleted_at IS NULL
      UNION ALL SELECT thumb_storage_key, thumb_url FROM gallery_assets WHERE deleted_at IS NULL AND thumb_url IS NOT NULL" > /tmp/gallery.list
  : > /tmp/gallery.todo
  while read -r key url; do
    case "$key" in
      ''|*..*|/*) continue ;;
    esac
    [ -s "/backups/gallery/$key" ] || echo "$key $url" >> /tmp/gallery.todo
  done < /tmp/gallery.list
  rm -f /tmp/gallery.failed
  # 8 downloads at a time; each file lands under its final name only when complete
  xargs -P 8 -n 2 sh -c '
    dest="/backups/gallery/$0"; mkdir -p "$(dirname "$dest")"
    if curl -fsS --max-time 60 -o "$dest.part" "$1"; then mv "$dest.part" "$dest"; else rm -f "$dest.part"; echo "$0" >> /tmp/gallery.failed; fi
  ' < /tmp/gallery.todo || true
  failed=$( [ -f /tmp/gallery.failed ] && wc -l < /tmp/gallery.failed || echo 0 )
  log "gallery mirror: $(wc -l < /tmp/gallery.list) files, $(wc -l < /tmp/gallery.todo) were new, $failed failed"
  [ "$failed" -eq 0 ] || log "WARNING: some gallery files could not be downloaded; they are retried next run"
fi

find /backups/db -name 'bb-*.dump.enc*' -mtime "+${KEEP}" -print -delete | sed 's/^/pruned /' || true
date -u +%Y-%m-%dT%H:%M:%SZ > /backups/last-success
log "backup complete"
# Optional dead-man's switch (e.g. healthchecks.io): it alerts you when this ping stops arriving.
if [ -n "${BACKUP_PING_URL:-}" ]; then
  curl -fsS --max-time 10 -o /dev/null "$BACKUP_PING_URL" || log "WARNING: ping failed"
fi
