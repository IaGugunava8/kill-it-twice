# Replication Operating Contract

Status: accepted for the assignment implementation.

This contract fixes the correctness rules used by the database schema, workers, UI, and automated gate verification. Changing one of these rules requires updating the implementation and its verification oracle together.

## Source capture permission

The assignment environment permits installing PostgreSQL tables and a trigger-backed transactional outbox next to the source data. The source mutation, entity-version increment, and immutable outbox insert commit in one transaction.

The replication worker may read source entities and claim outbox entries. It does not modify source entities. The UI simulation feature changes source records through a dedicated application endpoint that follows the same transactional capture path.

If a real integration grants read-only source access, this trigger-backed design must be replaced by supported CDC. Timestamp polling is not considered equivalent because it cannot reliably preserve intermediate changes and hard deletes.

## Identity and versioning

An entity is uniquely identified by:

```text
(source_system, entity_type, entity_id)
```

The Elasticsearch document ID is the canonical string form of that tuple.

Each accepted mutation increments a monotonically increasing 64-bit entity version in the source transaction. Versions cross JSON boundaries as decimal strings so JavaScript cannot lose integer precision.

A logical event is uniquely identified by:

```text
(source_system, entity_type, entity_id, entity_version)
```

The event ID is deterministic from those fields. Backfill, incremental capture, worker retries, and broker redelivery reuse that ID. An attempt ID may change; the logical event ID may not.

For a given event ID, the canonical operation, payload, and payload hash are immutable. An equal event ID with a different hash is an integrity failure.

## Change envelope

Every event includes:

```text
schema_version
event_id
source_system
entity_type
entity_id
entity_version
operation: upsert | delete
source_timestamp
canonical_payload
payload_hash
```

Reader-specific data such as backfill run ID, page, capture time, and attempt count is metadata and is not part of the logical payload.

## Delete contract

Deletes create a new source version and a tombstone event. The assignment retains source tombstones and writes versioned tombstone documents to Elasticsearch. Normal searches exclude tombstones.

An older upsert can therefore never resurrect a deleted entity. Physical tombstone removal is outside the initial scope and requires a separately defined safe replay horizon.

## Concurrent loading contract

Backfill and incremental capture run concurrently.

At creation, a backfill run stores an upper entity-ID boundary. It scans through that boundary with keyset pagination in bounded pages. New entities beyond the boundary are captured incrementally.

Each backfill page is staged durably in the same transaction that advances its checkpoint. A crash before commit permits the page to be read again. A crash after commit resumes after the saved checkpoint.

Incremental capture continuously hands committed outbox events to durable pipeline work. If both readers observe the same entity version, the deterministic event identity and database uniqueness constraint collapse it into one logical event.

This is a convergent backfill over a changing source, not a frozen historical snapshot. Destination version checks ensure that an old backfill observation cannot replace newer incremental state.

## Delivery guarantee

The system provides **at-least-once transport with effectively-once materialized effects**.

Retries and duplicate transport deliveries are expected after uncertain failures. Elasticsearch uses stable document IDs and external source versions. The RabbitMQ consumer uses an inbox table keyed by event ID and commits its receipt and logical effect together before acknowledging the broker message.

The system does not claim a distributed exactly-once transaction across PostgreSQL, Elasticsearch, and RabbitMQ.

## Delivery success

The following transitions have different meanings:

| Stage | Success condition |
| --- | --- |
| Source capture | The source mutation and outbox event committed together |
| Pipeline capture | The canonical event and independent delivery rows are durable |
| Elasticsearch | The expected version was indexed, or a verified equal/newer version already exists |
| RabbitMQ publish | The persistent message was routed to the required durable queue and publisher-confirmed |
| Consumer processing | The consumer inbox and effect committed before acknowledgement |
| End-to-end verification | Search state and consumer effects match the source oracle |

An equal Elasticsearch version is successful only when its canonical hash matches. A newer version makes the older event superseded. Quarantine preserves an event but is not a successful delivery.

Each event has independent Elasticsearch and RabbitMQ delivery state:

```text
pending
in_flight
retry_scheduled
delivered
superseded
quarantined
```

One successful destination never conceals failure at the other.

## Pause and completion

Pausing backfill stops acquisition of the next backfill page at a safe boundary. Incremental capture and delivery of already staged work continue. Checkpoints and pending delivery state remain durable.

Backfill run states are:

```text
created
running
paused
scanned
completed
completed_with_errors
failed
```

- `scanned` means the durable checkpoint reached the run boundary and all pages were staged.
- `completed` means scanning finished and all run deliveries ended successfully.
- `completed_with_errors` means scanning finished and all work is terminal, but at least one delivery remains quarantined.
- `failed` is reserved for an unrecoverable configuration or integrity failure.

Starting backfill repeatedly returns the current active run rather than creating competing scanners.

## Capacity contract

The full verification profile uses 2,000,000 records with approximately 1–2 KiB of serialized content per record. The default backfill page size is 500 records with an additional request-byte limit.

The worker starts with a 512 MiB memory target. Source pages, outstanding sink requests, RabbitMQ confirms, and consumer prefetch are bounded independently. The implementation must stream fixture generation and oracle comparisons instead of loading the dataset into memory.

A smaller development profile may accelerate iteration but cannot be reported as the full gate result.

## Verification oracle

Verification stops the mutation generator, waits for active source transactions to settle, and records a source-event barrier. Source-owned data through that barrier is the truth.

Elasticsearch is compared by entity ID, version, deletion state, and canonical payload hash. The report distinguishes missing, unexpected, stale, and mismatched documents.

The consumer inbox and logical effects are compared with the expected source event-ID set. The report distinguishes missing events, unexpected events, transport redeliveries, duplicate receipts, and duplicate logical effects.

Equal totals alone are never considered sufficient evidence.

## Gate assertions

- **G1:** An abrupt worker kill resumes the original run from its last committed checkpoint. At most an uncommitted page is reread. Final oracle reconciliation finds no unexplained loss or stale state.
- **G2:** Elasticsearch has one correct current document per entity and the consumer applies one logical effect per expected event. Transport duplicate attempts may be nonzero.
- **G3:** A 60-second Elasticsearch outage preserves pending work, follows persisted bounded backoff, creates no outage-related DLQ loss, and catches up without restarting the worker.
- **G4:** One real 500-operation bulk request produces exactly 497 successful search writes and 3 contextual search DLQ entries. All 500 events still reach the independent consumer.
- **G5:** Metrics, structured logs, public status APIs, and the UI expose backfill progress, per-sink throughput, incremental lag, consumer lag, DLQ size, dependency health, and recovery state.

Gate results remain not run until the automated verifier exercises the real faults and produces evidence.
