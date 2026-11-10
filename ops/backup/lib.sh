#!/bin/sh
# Shared helpers. Never echo DATABASE_URL or the passphrase.
set -eu

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [backup] $*"; }
die() { log "ERROR: $*"; exit 1; }

# libpq needs sslmode in the URL; the Node app uses PGSSL=true instead.
pg_url() {
  url="${1:?url}"
  if [ "${PGSSL:-false}" = "true" ] && ! echo "$url" | grep -q 'sslmode='; then
    case "$url" in
      *\?*) url="${url}&sslmode=require" ;;
      *) url="${url}?sslmode=require" ;;
    esac
  fi
  echo "$url"
}

need_passphrase() {
  [ -n "${BACKUP_PASSPHRASE:-}" ] || die "BACKUP_PASSPHRASE is not set (a long random value in .env; keep a copy somewhere safe, without it backups cannot be opened)"
  [ "${#BACKUP_PASSPHRASE}" -ge 16 ] || die "BACKUP_PASSPHRASE must be at least 16 characters"
}

encrypt() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE; }
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE; }

# The tables a restore is checked against.
KEY_TABLES="schema_migrations tenants users roles contacts conversations messages leads quotes bookings booking_payments gallery_assets gallery_items templates audit_log"
