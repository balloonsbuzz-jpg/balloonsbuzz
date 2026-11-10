#!/bin/sh
# Restore a backup into an EMPTY database.
#   restore.sh <backup.dump.enc> <target database URL> [--replace-live]
# Refuses to touch the live DATABASE_URL unless --replace-live is given.
. /ops/lib.sh
need_passphrase
usage="usage: restore.sh <backup.dump.enc> <target-url> [--replace-live]"
file="${1:?$usage}"
target="${2:?$usage}"
[ -f "$file" ] || die "no such file: $file"
if [ -n "${DATABASE_URL:-}" ] && [ "$target" = "$DATABASE_URL" ] && [ "${3:-}" != "--replace-live" ]; then
  die "the target is the LIVE database. Restore into a new database first (see docs/DEPLOY.md)"
fi
if [ -f "${file}.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256" > /dev/null) || die "checksum mismatch: the backup file is damaged"
fi
T=$(pg_url "$target")
tables=$(psql "$T" -At -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
[ "$tables" = "0" ] || die "the target database is not empty ($tables tables). Use a new, empty database"
log "restoring $(basename "$file")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
decrypt < "$file" > "$work/db.dump" || die "could not decrypt: wrong BACKUP_PASSPHRASE or damaged file"
# a new database already has the public schema; skip the dump's CREATE SCHEMA public
pg_restore --list "$work/db.dump" | grep -v ' SCHEMA - public ' > "$work/toc.list"
pg_restore --dbname="$T" --no-owner --no-privileges --exit-on-error --use-list="$work/toc.list" "$work/db.dump"
log "restored. Row counts:"
for t in $KEY_TABLES; do
  printf '  %-20s %s\n' "$t" "$(psql "$T" -At -c "SELECT count(*) FROM public.$t")"
done
