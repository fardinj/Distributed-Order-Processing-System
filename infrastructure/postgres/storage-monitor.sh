#!/bin/sh
set -eu
export PGHOST=postgres PGDATABASE=commerce PGUSER=commerce_runtime
export PGPASSWORD="$(cat /run/secrets/commerce_db_password)"
good_samples=0
while true; do
  # Fail closed for NEW admission on stale/failed observations; accepted SQL work is untouched.
  free_kib=$(df -Pk /storage | awk 'NR==2 {print $4}')
  used_pct=$(df -Pk /storage | awk 'NR==2 {gsub(/%/,"",$5);print $5}')
  healthy=false
  if [ "$free_kib" -ge "${MIN_FREE_KIB:-2097152}" ] && [ "$used_pct" -lt 90 ]; then
    good_samples=$((good_samples+1))
    if [ "$good_samples" -ge 3 ]; then healthy=true; good_samples=3; fi
  else good_samples=0; fi
  PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=2000 -c lock_timeout=1000' psql -X -q -v ON_ERROR_STOP=1 -c "UPDATE admission_budget SET storage_healthy=$healthy,storage_checked_at=clock_timestamp() WHERE id=1" >/dev/null 2>&1 || echo 'storage_monitor_observation_deferred'
  sleep 5
done
