#!/usr/bin/env bash
set -euo pipefail

# Only runs on an empty PostgreSQL data volume. Never interpolate raw SQL secrets.
for database in commerce billing bank; do
  runtime="${database}_runtime"
  migrator="${database}_migrator"
  runtime_password="$(cat "/run/secrets/${database}_db_password")"
  migrator_password="$(cat "/run/secrets/${database}_migration_password")"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v database="$database" -v runtime="$runtime" -v migrator="$migrator" \
    -v runtime_password="$runtime_password" -v migrator_password="$migrator_password" <<'SQL'
CREATE ROLE :"runtime" LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE :"migrator" LOGIN PASSWORD :'migrator_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE DATABASE :"database" OWNER :"migrator";
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO :"runtime";
SQL
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" \
    -v runtime="$runtime" -v migrator="$migrator" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO :"migrator";
GRANT USAGE ON SCHEMA public TO :"runtime";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"runtime";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"runtime";
SQL
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v identity_password="$(cat /run/secrets/identity_db_password)" <<'SQL'
CREATE ROLE identity_owner LOGIN PASSWORD :'identity_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE DATABASE identity OWNER identity_owner;
REVOKE ALL ON DATABASE identity FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname identity <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO identity_owner;
SQL
