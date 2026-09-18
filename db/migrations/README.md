# Database migrations

Versioned PostgreSQL migrations live in this directory. `db/run-migrations.sh` records each filename and SHA-256 checksum in `public.schema_migrations` and applies pending files in a transaction.

Never edit a migration after it has been applied. Add a new, monotonically numbered SQL file for every schema change.

Current migrations:

- `0001-bootstrap.sql`: database schemas and bootstrap marker.
- `0002-source-capture.sql`: versioned source records, transactional outbox, and oracle views.
- `0003-pipeline-staging.sql`: backfill runs, canonical events, acquisition receipts, per-sink deliveries, leases, settings, and DLQ storage.
