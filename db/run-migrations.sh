#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version TEXT PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
SQL

for migration in /migrations/*.sql; do
  version=$(basename "$migration")
  checksum=$(sha256sum "$migration" | cut -d ' ' -f 1)
  applied_checksum=$(
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At \
      -c "SELECT checksum FROM public.schema_migrations WHERE version = '$version'"
  )

  if [ -n "$applied_checksum" ]; then
    if [ "$applied_checksum" != "$checksum" ]; then
      echo "Migration checksum mismatch: $version" >&2
      exit 1
    fi
    echo "Already applied: $version"
    continue
  fi

  echo "Applying: $version"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 \
    -f "$migration" \
    -c "INSERT INTO public.schema_migrations (version, checksum) VALUES ('$version', '$checksum')"
done
