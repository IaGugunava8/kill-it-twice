import type { Pool, PoolClient } from 'pg';

export type DeliveryDestination = 'elasticsearch' | 'rabbitmq';

export interface TransactionHooks {
  beforeCommit?: () => Promise<void> | void;
}

export interface HandoffOptions {
  limit: number;
  sourceSystem?: string;
}

export interface HandoffResult {
  captured: number;
  eventIds: string[];
}

export interface BackfillRun {
  id: string;
  sourceSystem: string;
  state: string;
  scanBoundary: string;
  checkpointEntityId: string;
  pageSize: number;
  rowsScanned: string;
  pagesStaged: string;
}

export interface BackfillPageResult {
  runId: string;
  staged: number;
  checkpointEntityId: string;
  state: string;
  eventIds: string[];
}

export interface ClaimOptions {
  destination: DeliveryDestination;
  owner: string;
  limit: number;
  leaseMs: number;
}

export interface ClaimedDelivery {
  id: string;
  eventId: string;
  destination: DeliveryDestination;
  attemptCount: number;
  claimGeneration: string;
  leaseExpiresAt: Date;
  schemaVersion: number;
  sourceSystem: string;
  entityType: string;
  entityId: string;
  entityVersion: string;
  operation: 'upsert' | 'delete';
  sourceTimestamp: Date;
  canonicalPayload: Record<string, unknown>;
  payloadHash: string;
}

interface CanonicalEvent {
  event_id: string;
  schema_version: number;
  source_system: string;
  entity_type: string;
  entity_id: string;
  entity_version: string;
  operation: 'upsert' | 'delete';
  source_timestamp: Date;
  canonical_payload: Record<string, unknown>;
  payload_hash: string;
}

interface BackfillRunRow {
  id: string;
  source_system: string;
  state: string;
  scan_boundary: string;
  checkpoint_entity_id: string;
  page_size: number;
  rows_scanned: string;
  pages_staged: string;
}

const DESTINATIONS: DeliveryDestination[] = ['elasticsearch', 'rabbitmq'];

export class PipelineRepository {
  constructor(private readonly pool: Pool) {}

  async handoffOutboxBatch(
    options: HandoffOptions,
    hooks: TransactionHooks = {},
  ): Promise<HandoffResult> {
    assertPositiveInteger(options.limit, 'limit', 10_000);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await client.query<CanonicalEvent & { position: string }>(
        `SELECT
           outbox.position,
           outbox.event_id,
           outbox.schema_version,
           outbox.source_system,
           outbox.entity_type,
           outbox.entity_id,
           outbox.entity_version,
           outbox.operation,
           outbox.source_timestamp,
           outbox.canonical_payload,
           outbox.payload_hash
         FROM source.outbox_events AS outbox
         WHERE ($1::text IS NULL OR outbox.source_system = $1)
           AND NOT EXISTS (
             SELECT 1
             FROM pipeline.source_event_captures AS capture
             WHERE capture.outbox_position = outbox.position
           )
         ORDER BY outbox.position
         FOR UPDATE OF outbox SKIP LOCKED
         LIMIT $2`,
        [options.sourceSystem ?? null, options.limit],
      );

      for (const event of result.rows) {
        await this.stageCanonicalEvent(client, event);
        await client.query(
          `INSERT INTO pipeline.source_event_captures (event_id, outbox_position)
           VALUES ($1, $2)
           ON CONFLICT (event_id) DO NOTHING`,
          [event.event_id, event.position],
        );
      }

      await hooks.beforeCommit?.();
      await client.query('COMMIT');
      return {
        captured: result.rowCount ?? 0,
        eventIds: result.rows.map((event) => event.event_id),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createBackfillRun(
    sourceSystem: string,
    pageSize: number,
    configuration: Record<string, unknown> = {},
  ): Promise<BackfillRun> {
    assertNonEmpty(sourceSystem, 'sourceSystem');
    assertPositiveInteger(pageSize, 'pageSize', 10_000);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const inserted = await client.query<BackfillRunRow>(
        `INSERT INTO pipeline.backfill_runs (
           source_system,
           state,
           scan_boundary,
           page_size,
           configuration,
           started_at
         )
         SELECT
           $1,
           'running',
           COALESCE(max(customer.id), 0),
           $2,
           $3::jsonb,
           clock_timestamp()
         FROM source.customers AS customer
         WHERE customer.source_system = $1
         ON CONFLICT DO NOTHING
         RETURNING
           id,
           source_system,
           state,
           scan_boundary,
           checkpoint_entity_id,
           page_size,
           rows_scanned,
           pages_staged`,
        [sourceSystem, pageSize, JSON.stringify(configuration)],
      );

      const row =
        inserted.rows[0] ?? (await this.selectActiveRun(client, sourceSystem));
      await client.query('COMMIT');
      return mapBackfillRun(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async stageBackfillPage(
    runId: string,
    hooks: TransactionHooks = {},
  ): Promise<BackfillPageResult> {
    assertNonEmpty(runId, 'runId');
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const locked = await client.query<BackfillRunRow>(
        `SELECT
           id,
           source_system,
           state,
           scan_boundary,
           checkpoint_entity_id,
           page_size,
           rows_scanned,
           pages_staged
         FROM pipeline.backfill_runs
         WHERE id = $1
         FOR UPDATE`,
        [runId],
      );
      const run = locked.rows[0];
      if (!run) {
        throw new Error(`Backfill run ${runId} does not exist`);
      }
      if (run.state !== 'running') {
        throw new Error(`Backfill run ${runId} is ${run.state}, not running`);
      }

      const page = await client.query<
        CanonicalEvent & { source_entity_id: string }
      >(
        `SELECT
           customer.id::text AS source_entity_id,
           source.customer_event_id(customer) AS event_id,
           1::smallint AS schema_version,
           customer.source_system,
           'customer'::text AS entity_type,
           customer.id::text AS entity_id,
           customer.version AS entity_version,
           CASE WHEN customer.deleted THEN 'delete' ELSE 'upsert' END AS operation,
           customer.updated_at AS source_timestamp,
           source.customer_payload(
             customer,
             CASE WHEN customer.deleted THEN 'delete' ELSE 'upsert' END
           ) AS canonical_payload,
           source.payload_sha256(
             source.customer_payload(
               customer,
               CASE WHEN customer.deleted THEN 'delete' ELSE 'upsert' END
             )
           ) AS payload_hash
         FROM source.customers AS customer
         WHERE customer.source_system = $1
           AND customer.id > $2
           AND customer.id <= $3
         ORDER BY customer.id
         LIMIT $4`,
        [
          run.source_system,
          run.checkpoint_entity_id,
          run.scan_boundary,
          run.page_size,
        ],
      );

      for (const event of page.rows) {
        await this.stageCanonicalEvent(client, event);
        await client.query(
          `INSERT INTO pipeline.backfill_run_events (
             run_id,
             event_id,
             source_entity_id
           ) VALUES ($1, $2, $3)
           ON CONFLICT (run_id, event_id) DO NOTHING`,
          [runId, event.event_id, event.source_entity_id],
        );
      }

      const lastEntityId =
        page.rows.at(-1)?.source_entity_id ?? run.checkpoint_entity_id;
      const scanComplete =
        page.rows.length < run.page_size ||
        BigInt(lastEntityId) >= BigInt(run.scan_boundary);
      const updated = await client.query<BackfillRunRow>(
        `UPDATE pipeline.backfill_runs
         SET checkpoint_entity_id = $2,
             rows_scanned = rows_scanned + $3,
             pages_staged = pages_staged + CASE WHEN $3 > 0 THEN 1 ELSE 0 END,
             state = CASE WHEN $4 THEN 'scanned' ELSE state END,
             scanned_at = CASE WHEN $4 THEN clock_timestamp() ELSE scanned_at END,
             revision = revision + 1
         WHERE id = $1
         RETURNING
           id,
           source_system,
           state,
           scan_boundary,
           checkpoint_entity_id,
           page_size,
           rows_scanned,
           pages_staged`,
        [runId, lastEntityId, page.rows.length, scanComplete],
      );

      await hooks.beforeCommit?.();
      await client.query('COMMIT');
      return {
        runId,
        staged: page.rowCount ?? 0,
        checkpointEntityId: updated.rows[0].checkpoint_entity_id,
        state: updated.rows[0].state,
        eventIds: page.rows.map((event) => event.event_id),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDeliveries(options: ClaimOptions): Promise<ClaimedDelivery[]> {
    assertNonEmpty(options.owner, 'owner');
    assertPositiveInteger(options.limit, 'limit', 10_000);
    assertPositiveInteger(options.leaseMs, 'leaseMs', 86_400_000);

    const result = await this.pool.query<{
      id: string;
      event_id: string;
      destination: DeliveryDestination;
      attempt_count: number;
      claim_generation: string;
      lease_expires_at: Date;
      schema_version: number;
      source_system: string;
      entity_type: string;
      entity_id: string;
      entity_version: string;
      operation: 'upsert' | 'delete';
      source_timestamp: Date;
      canonical_payload: Record<string, unknown>;
      payload_hash: string;
    }>(
      `WITH candidates AS (
         SELECT delivery.id
         FROM pipeline.deliveries AS delivery
         WHERE delivery.destination = $1
           AND delivery.status IN ('pending', 'retry_scheduled')
           AND delivery.next_attempt_at <= clock_timestamp()
         ORDER BY delivery.next_attempt_at, delivery.id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       ), claimed AS (
         UPDATE pipeline.deliveries AS delivery
         SET status = 'in_flight',
             attempt_count = delivery.attempt_count + 1,
             claim_owner = $3,
             claim_generation = delivery.claim_generation + 1,
             lease_expires_at = clock_timestamp() + ($4::integer * interval '1 millisecond'),
             updated_at = clock_timestamp()
         FROM candidates
         WHERE delivery.id = candidates.id
         RETURNING delivery.*
       )
       SELECT
         claimed.id,
         claimed.event_id,
         claimed.destination,
         claimed.attempt_count,
         claimed.claim_generation,
         claimed.lease_expires_at,
         event.schema_version,
         event.source_system,
         event.entity_type,
         event.entity_id,
         event.entity_version,
         event.operation,
         event.source_timestamp,
         event.canonical_payload,
         event.payload_hash
       FROM claimed
       JOIN pipeline.events AS event ON event.event_id = claimed.event_id
       ORDER BY claimed.id`,
      [options.destination, options.limit, options.owner, options.leaseMs],
    );

    return result.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      destination: row.destination,
      attemptCount: row.attempt_count,
      claimGeneration: row.claim_generation,
      leaseExpiresAt: row.lease_expires_at,
      schemaVersion: row.schema_version,
      sourceSystem: row.source_system,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityVersion: row.entity_version,
      operation: row.operation,
      sourceTimestamp: row.source_timestamp,
      canonicalPayload: row.canonical_payload,
      payloadHash: row.payload_hash,
    }));
  }

  async recoverExpiredClaims(
    destination?: DeliveryDestination,
  ): Promise<number> {
    const result = await this.pool.query(
      `UPDATE pipeline.deliveries
       SET status = 'retry_scheduled',
           next_attempt_at = clock_timestamp(),
           claim_owner = NULL,
           lease_expires_at = NULL,
           last_error = jsonb_build_object(
             'category', 'lease_expired',
             'recoveredAt', clock_timestamp()
           ),
           updated_at = clock_timestamp()
       WHERE status = 'in_flight'
         AND lease_expires_at <= clock_timestamp()
         AND ($1::text IS NULL OR destination = $1)`,
      [destination ?? null],
    );
    return result.rowCount ?? 0;
  }

  async markDeliveryDelivered(
    deliveryId: string,
    owner: string,
    claimGeneration: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE pipeline.deliveries
       SET status = 'delivered',
           claim_owner = NULL,
           lease_expires_at = NULL,
           completed_at = clock_timestamp(),
           updated_at = clock_timestamp(),
           last_error = NULL
       WHERE id = $1
         AND status = 'in_flight'
         AND claim_owner = $2
         AND claim_generation = $3`,
      [deliveryId, owner, claimGeneration],
    );
    return result.rowCount === 1;
  }

  async scheduleRetry(
    deliveryId: string,
    owner: string,
    claimGeneration: string,
    delayMs: number,
    error: Record<string, unknown>,
  ): Promise<boolean> {
    assertPositiveInteger(delayMs, 'delayMs', 86_400_000);
    const result = await this.pool.query(
      `UPDATE pipeline.deliveries
       SET status = 'retry_scheduled',
           next_attempt_at = clock_timestamp() + ($4::integer * interval '1 millisecond'),
           claim_owner = NULL,
           lease_expires_at = NULL,
           last_error = $5::jsonb,
           updated_at = clock_timestamp()
       WHERE id = $1
         AND status = 'in_flight'
         AND claim_owner = $2
         AND claim_generation = $3`,
      [deliveryId, owner, claimGeneration, delayMs, JSON.stringify(error)],
    );
    return result.rowCount === 1;
  }

  private async selectActiveRun(
    client: PoolClient,
    sourceSystem: string,
  ): Promise<BackfillRunRow> {
    const selected = await client.query<BackfillRunRow>(
      `SELECT
         id,
         source_system,
         state,
         scan_boundary,
         checkpoint_entity_id,
         page_size,
         rows_scanned,
         pages_staged
       FROM pipeline.backfill_runs
       WHERE source_system = $1
         AND state IN ('created', 'running', 'paused', 'scanned')`,
      [sourceSystem],
    );
    if (!selected.rows[0]) {
      throw new Error(
        `Unable to create or find active backfill for ${sourceSystem}`,
      );
    }
    return selected.rows[0];
  }

  private async stageCanonicalEvent(
    client: PoolClient,
    event: CanonicalEvent,
  ): Promise<void> {
    const inserted = await client.query(
      `INSERT INTO pipeline.events (
         event_id,
         schema_version,
         source_system,
         entity_type,
         entity_id,
         entity_version,
         operation,
         source_timestamp,
         canonical_payload,
         payload_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.event_id,
        event.schema_version,
        event.source_system,
        event.entity_type,
        event.entity_id,
        event.entity_version,
        event.operation,
        event.source_timestamp,
        JSON.stringify(event.canonical_payload),
        event.payload_hash,
      ],
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query<CanonicalEvent>(
        `SELECT
           event_id,
           schema_version,
           source_system,
           entity_type,
           entity_id,
           entity_version,
           operation,
           source_timestamp,
           canonical_payload,
           payload_hash
         FROM pipeline.events
         WHERE event_id = $1`,
        [event.event_id],
      );
      const stored = existing.rows[0];
      if (
        !stored ||
        stored.schema_version !== event.schema_version ||
        stored.source_system !== event.source_system ||
        stored.entity_type !== event.entity_type ||
        stored.entity_id !== event.entity_id ||
        stored.entity_version !== event.entity_version ||
        stored.operation !== event.operation ||
        stored.payload_hash !== event.payload_hash
      ) {
        throw new Error(
          `Canonical event identity conflict for ${event.event_id}`,
        );
      }
    }

    await client.query(
      `INSERT INTO pipeline.deliveries (event_id, destination)
       SELECT $1, destination
       FROM unnest($2::text[]) AS destination
       ON CONFLICT (event_id, destination) DO NOTHING`,
      [event.event_id, DESTINATIONS],
    );
  }
}

function mapBackfillRun(row: BackfillRunRow): BackfillRun {
  return {
    id: row.id,
    sourceSystem: row.source_system,
    state: row.state,
    scanBoundary: row.scan_boundary,
    checkpointEntityId: row.checkpoint_entity_id,
    pageSize: row.page_size,
    rowsScanned: row.rows_scanned,
    pagesStaged: row.pages_staged,
  };
}

function assertPositiveInteger(
  value: number,
  name: string,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
}
