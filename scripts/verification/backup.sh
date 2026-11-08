#!/bin/bash
set -euo pipefail
umask 077
case "${BACKUP_RUN:-}" in ''|*[!a-zA-Z0-9_-]*) echo 'A safe unique BACKUP_RUN is required' >&2; exit 1;; esac
target="/verification/backups/$BACKUP_RUN"
export PGHOST=postgres PGCONNECT_TIMEOUT=5
if [ "${1:-}" = dump ]; then
 test ! -e "$target" || { echo 'Refusing to overwrite an existing backup' >&2; exit 1; }
 mkdir -p "$target"
 cp /verification/backup-manifest.json "$target/manifest.json"
 for owner in commerce billing bank identity; do
  if [ "$owner" = identity ]; then export PGUSER=identity_owner PGPASSWORD="$(cat /run/secrets/identity_db_password)";
  else export PGUSER="${owner}_migrator" PGPASSWORD="$(cat "/run/secrets/${owner}_migration_password")"; fi
  pg_dump --format=custom --no-tablespaces --file="$target/$owner.dump" "$owner"
  echo "Backed up owner database: $owner"
 done
 (cd "$target" && sha256sum *.dump > SHA256SUMS)
elif [ "${1:-}" = restore ]; then
 export PGUSER=postgres PGPASSWORD="$(cat /run/secrets/postgres_admin_password)"
 test -f "$target/restore-target-id"
 expected=$(cat "$target/restore-target-id")
 actual=$(psql -X -tAc 'SELECT system_identifier::text FROM pg_control_system()' postgres)
 test "$actual" = "$expected" || { echo 'Restore target guard mismatch' >&2; exit 1; }
 (cd "$target" && sha256sum --check SHA256SUMS)
 for owner in commerce billing bank identity; do
  pg_restore --list "$target/$owner.dump" | sed '/ SCHEMA - public /d' > "$target/$owner.restore-list"
  pg_restore --exit-on-error --no-tablespaces --use-list="$target/$owner.restore-list" --dbname="$owner" "$target/$owner.dump"
  echo "Restored owner database: $owner"
 done
else echo 'Specify dump or restore' >&2; exit 1; fi
