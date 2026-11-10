#!/bin/sh
# Default: one backup a day at BACKUP_AT (UTC, HH:MM). A plain timer loop, because cron
# needs root and this container runs as an unprivileged user.
# One-offs:  docker compose run --rm backup backup | drill | restore <file> <url>
. /ops/lib.sh
case "${1:-schedule}" in
  backup) exec /ops/backup.sh ;;
  drill) exec /ops/drill.sh ;;
  restore) shift; exec /ops/restore.sh "$@" ;;
  schedule) ;;
  *) exec "$@" ;;
esac
need_passphrase
AT="${BACKUP_AT:-21:30}"   # 21:30 UTC = 03:00 IST, when nobody is booking balloons
echo "$AT" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$' || die "BACKUP_AT must be HH:MM (UTC), got '$AT'"
# BACKUP_EVERY_MIN is for testing the loop (e.g. 2); leave it unset in production.
EVERY="${BACKUP_EVERY_MIN:-}"
if [ -n "$EVERY" ]; then log "backing up every ${EVERY} min (test mode)"
else log "daily backup at ${AT} UTC, keeping ${BACKUP_KEEP_DAYS:-14} days of database backups"; fi

trap 'log "stopping"; exit 0' TERM INT
while true; do
  now=$(date -u +%s)
  if [ -n "$EVERY" ]; then
    wait_s=$((EVERY * 60))
  else
    next=$(date -u -d "$(date -u +%Y-%m-%d) ${AT}:00" +%s)
    [ "$next" -gt "$now" ] || next=$((next + 86400))
    wait_s=$((next - now))
  fi
  # sleep in the background so `docker stop` (SIGTERM) is handled at once
  sleep "$wait_s" &
  wait $!
  /ops/backup.sh || log "backup FAILED (will try again at the next scheduled time)"
done
