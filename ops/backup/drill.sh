#!/bin/sh
# Restore drill: restore the newest backup into a temporary database on the same server,
# compare it with the live database, then drop the temporary database.
. /ops/lib.sh
need_passphrase
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set"
file=$(ls -1t /backups/db/bb-*.dump.enc 2> /dev/null | head -1 || true)
[ -n "$file" ] || die "no backups in /backups/db (run a backup first)"
LIVE=$(pg_url "$DATABASE_URL")
name="bb_restore_drill_$(date -u +%Y%m%d%H%M%S)"
# same server and credentials, different database name
base=$(echo "$DATABASE_URL" | sed -E 's#^(postgres(ql)?://[^/]+)/.*$#\1#')
query=$(echo "$DATABASE_URL" | sed -nE 's#^[^?]*(\?.*)$#\1#p')
TARGET="${base}/${name}${query}"

cleanup() {
  if psql "$LIVE" -q -c "DROP DATABASE IF EXISTS ${name} WITH (FORCE)" > /dev/null; then log "dropped ${name}"
  else log "WARNING: could not drop ${name}; drop it by hand"; fi
}
trap cleanup EXIT
log "drill: creating ${name}"
psql "$LIVE" -q -c "CREATE DATABASE ${name}"
/ops/restore.sh "$file" "$TARGET" > /dev/null
T=$(pg_url "$TARGET")
log "drill: comparing $(basename "$file") with the live database"
for t in $KEY_TABLES; do
  a=$(psql "$LIVE" -At -c "SELECT count(*) FROM public.$t")
  b=$(psql "$T" -At -c "SELECT count(*) FROM public.$t")
  mark="same"
  [ "$a" = "$b" ] || mark="differs (changes made after the backup are normal)"
  printf '  %-20s live %-8s restored %-8s %s\n' "$t" "$a" "$b" "$mark"
done
m1=$(psql "$LIVE" -At -c "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations")
m2=$(psql "$T" -At -c "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations")
fk=$(psql "$T" -At -c "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace")
log "restored database: $fk foreign keys"
[ "$m1" = "$m2" ] || die "RESTORE DRILL FAILED: the backup's schema version differs from live (migrations ran after it?)"
log "RESTORE DRILL PASSED"
