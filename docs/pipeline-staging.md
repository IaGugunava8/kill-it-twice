# Durable Pipeline Staging and Claims

Step 4 introduces PostgreSQL as the durable coordination boundary between source acquisition and destination delivery. It does not deliver to Elasticsearch or RabbitMQ yet; those workers are implemented in later steps.

## State model

`pipeline.events` contains one immutable canonical row per logical source event. The deterministic event ID and the additional unique constraint on `(source_system, entity_type, entity_id, entity_version)` reject both duplicate work and conflicting identities.

Acquisition provenance is stored separately:

- `pipeline.source_event_captures` records that a source outbox position was handed off.
- `pipeline.backfill_run_events` records that a backfill run staged a source entity.

Both acquisition modes may point at the same canonical event. This is how concurrent backfill and incremental capture converge without creating duplicate destination work.

`pipeline.deliveries` contains exactly one row for each event and destination. Elasticsearch and RabbitMQ therefore advance independently. A unique constraint on `(event_id, destination)` makes acquisition retries harmless.

## Atomic acquisition boundaries

Incremental handoff performs these operations in one transaction:

1. Lock a bounded set of uncaptured source outbox rows with `FOR UPDATE SKIP LOCKED`.
2. Insert each canonical event, tolerating only an identical existing event.
3. Insert the Elasticsearch and RabbitMQ delivery rows.
4. Insert the source handoff receipt.
5. Commit.

If the connection or process ends before commit, PostgreSQL preserves none of those changes and the source rows remain eligible. A retry stages the same deterministic event IDs.

A backfill page also uses one transaction:

1. Lock the run row so only one transaction can advance its checkpoint.
2. Read one keyset page after the committed checkpoint and no further than the run's fixed boundary.
3. Insert canonical events, per-sink deliveries, and run-event provenance.
4. Advance row/page counters and the checkpoint.
5. Mark the run `scanned` only when its boundary has been covered, then commit.

The checkpoint cannot become visible without the page's durable work. An interrupted transaction may reread one page; uniqueness constraints make that safe.

## Claims, expiry, and fencing

Delivery workers claim ready rows with `FOR UPDATE SKIP LOCKED`. A claim stores its owner, expiry time, incremented attempt count, and incremented `claim_generation`.

An expired `in_flight` row returns to `retry_scheduled` and becomes immediately eligible. The generation is retained. Completion and retry updates require the current owner and generation, so a delayed response from an older worker cannot overwrite the result of a newer claim.

Retry eligibility is persisted in `next_attempt_at`. The database index covers only pending and scheduled rows ordered by destination and eligibility time, while a second partial index supports expired-lease recovery. Later delivery steps will calculate bounded exponential delays and use these primitives.

## Configuration and DLQ storage

`pipeline.settings` installs bounded defaults for backfill page size, incremental batch size, delivery claim size, lease duration, and retry limits.

`pipeline.dlq_entries` preserves the rejected event, destination, original payload and hash, error details, attempt count, contextual metadata, and replay history. A partial unique index permits only one unresolved entry for a given event and destination. Step 6 and Step 8 will implement destination-specific classification and replay transitions.

## Verification

Run the disposable PostgreSQL integration suite:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test-source.ps1
```

or on macOS, Linux, and WSL:

```bash
sh ./scripts/test-source.sh
```

The Step 4 cases prove:

- interruption before an outbox-handoff commit leaves no event, delivery, or receipt;
- interruption before a backfill-page commit leaves its checkpoint and counters unchanged;
- retry commits each canonical event once with two independent deliveries;
- overlapping backfill and incremental acquisition converge on one logical event;
- an expired lease is recovered, and its previous worker generation is fenced;
- bounded settings and the unresolved-DLQ uniqueness rule are installed.

These are transaction-level Step 4 assertions. The final G1-G5 verifier will later kill real service containers and exercise real destination failures.
