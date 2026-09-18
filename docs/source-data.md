# Source Data and Event Oracle

Step 3 implements the relational source and its independent reconciliation inputs.

## Source tables

`source.customers` stores the current customer state. Its primary key is `(source_system, id)`, which is the unique entity identity fixed in the operating contract. Every accepted mutation increments the row-local `version` inside a `BEFORE` trigger.

Deletes are logical. `source.delete_customer(id, source_system)` sets `deleted = true`, records `deleted_at`, increments the version, and retains the row as a tombstone. Direct SQL `DELETE` is rejected so a late backfill observation cannot lose the deletion marker.

`source.outbox_events` stores the immutable event created by the same PostgreSQL transaction as the source mutation. A trigger rejects updates and deletes against this table. Its uniqueness constraints enforce one logical event per entity version.

The event ID has this deterministic form:

```text
<source_system>:customer:<entity_id>:<entity_version>
```

The canonical payload is PostgreSQL `jsonb`, and `payload_hash` is the lowercase SHA-256 digest of its canonical text representation. Entity versions are strings inside JSON payloads and remain 64-bit integers in relational columns.

## Oracle views

- `source.customer_state_oracle` derives the expected current document, operation, version, payload, and hash directly from the source row.
- `source.event_oracle` exposes the committed immutable event set expected at the independent consumer.

Verification must freeze source mutations at a recorded barrier before comparing these views with destinations. Outbox `position` is useful for work discovery but is not a commit-order watermark: overlapping transactions can allocate positions in one order and commit in the reverse order.

## Transaction guarantees

- A committed insert, update, or logical delete has exactly one matching source event.
- A rolled-back mutation leaves neither current-state changes nor an event.
- Event identity and canonical content are stable after commit.
- Replaying the deterministic seed with the same source system creates no additional records or events.
- Generator memory is bounded by `batch-size`; the default seed page is 500 records.

The integration suite opens independent database sessions to prove rollback behavior and overlapping commits. It also recalculates each test event's payload hash and verifies outbox immutability. `scripts/test-source.ps1` and `scripts/test-source.sh` run it in a disposable Compose project so test events never enter the development source.

## Migration execution

`db/run-migrations.sh` applies ordered SQL files during the single Compose startup path and stores their SHA-256 checksums in `public.schema_migrations`. A changed migration that was already applied causes startup to fail. Schema changes must therefore be added as a new numbered migration rather than rewriting history.
