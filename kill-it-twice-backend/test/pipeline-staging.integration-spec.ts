import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PipelineRepository } from '../libs/database/src/pipeline.repository.ts';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'TEST_DATABASE_URL is required; use scripts/test-source.ps1 or scripts/test-source.sh',
  );
}

const pool = new Pool({ connectionString, max: 8 });
const repository = new PipelineRepository(pool);

function testSourceSystem(label: string): string {
  return `staging-${label}-${randomUUID()}`;
}

async function insertCustomers(
  sourceSystem: string,
  ids: number[],
): Promise<void> {
  for (const id of ids) {
    await pool.query(
      `INSERT INTO source.customers (
         source_system,
         id,
         name,
         email,
         segment,
         balance,
         attributes
       ) VALUES ($1, $2, $3, $4, 'silver', 42.50, $5::jsonb)`,
      [
        sourceSystem,
        id,
        `Staging Customer ${id}`,
        `${sourceSystem}-${id}@example.test`,
        JSON.stringify({ fixture: 'pipeline-staging' }),
      ],
    );
  }
}

beforeAll(async () => {
  const result = await pool.query(
    `SELECT
       to_regclass('pipeline.backfill_runs') AS backfill_runs,
       to_regclass('pipeline.events') AS events,
       to_regclass('pipeline.deliveries') AS deliveries,
       to_regclass('pipeline.dlq_entries') AS dlq_entries`,
  );
  expect(result.rows[0]).toEqual({
    backfill_runs: 'pipeline.backfill_runs',
    events: 'pipeline.events',
    deliveries: 'pipeline.deliveries',
    dlq_entries: 'pipeline.dlq_entries',
  });
});

afterAll(async () => {
  await pool.end();
});

describe('durable pipeline staging', () => {
  it('rolls back the entire source-outbox handoff when interrupted before commit', async () => {
    const sourceSystem = testSourceSystem('handoff-rollback');
    await insertCustomers(sourceSystem, [101]);

    await expect(
      repository.handoffOutboxBatch(
        { sourceSystem, limit: 10 },
        {
          beforeCommit: () => {
            throw new Error('simulated staging process termination');
          },
        },
      ),
    ).rejects.toThrow(/simulated staging process termination/);

    const afterInterruption = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM pipeline.events WHERE source_system = $1) AS events,
         (SELECT count(*)::int
          FROM pipeline.source_event_captures AS capture
          JOIN pipeline.events AS event ON event.event_id = capture.event_id
          WHERE event.source_system = $1) AS captures,
         (SELECT count(*)::int
          FROM pipeline.deliveries AS delivery
          JOIN pipeline.events AS event ON event.event_id = delivery.event_id
          WHERE event.source_system = $1) AS deliveries`,
      [sourceSystem],
    );
    expect(afterInterruption.rows[0]).toEqual({
      events: 0,
      captures: 0,
      deliveries: 0,
    });

    const retried = await repository.handoffOutboxBatch({
      sourceSystem,
      limit: 10,
    });
    expect(retried.captured).toBe(1);

    const afterRetry = await pool.query(
      `SELECT
         count(DISTINCT event.event_id)::int AS events,
         count(DISTINCT capture.event_id)::int AS captures,
         count(delivery.id)::int AS deliveries
       FROM pipeline.events AS event
       JOIN pipeline.source_event_captures AS capture
         ON capture.event_id = event.event_id
       JOIN pipeline.deliveries AS delivery
         ON delivery.event_id = event.event_id
       WHERE event.source_system = $1`,
      [sourceSystem],
    );
    expect(afterRetry.rows[0]).toEqual({
      events: 1,
      captures: 1,
      deliveries: 2,
    });
  });

  it('commits a backfill page and its checkpoint atomically', async () => {
    const sourceSystem = testSourceSystem('backfill-rollback');
    await insertCustomers(sourceSystem, [11, 12, 13]);
    const run = await repository.createBackfillRun(sourceSystem, 2);
    expect(run).toMatchObject({
      state: 'running',
      scanBoundary: '13',
      checkpointEntityId: '0',
    });

    await expect(
      repository.stageBackfillPage(run.id, {
        beforeCommit: () => {
          throw new Error('simulated checkpoint process termination');
        },
      }),
    ).rejects.toThrow(/simulated checkpoint process termination/);

    const afterInterruption = await pool.query(
      `SELECT
         run.state,
         run.checkpoint_entity_id,
         run.rows_scanned,
         run.pages_staged,
         (SELECT count(*)::int
          FROM pipeline.backfill_run_events
          WHERE run_id = run.id) AS staged_events,
         (SELECT count(*)::int
          FROM pipeline.events
          WHERE source_system = $2) AS canonical_events
       FROM pipeline.backfill_runs AS run
       WHERE run.id = $1`,
      [run.id, sourceSystem],
    );
    expect(afterInterruption.rows[0]).toEqual({
      state: 'running',
      checkpoint_entity_id: '0',
      rows_scanned: '0',
      pages_staged: '0',
      staged_events: 0,
      canonical_events: 0,
    });

    const firstPage = await repository.stageBackfillPage(run.id);
    expect(firstPage).toMatchObject({
      staged: 2,
      checkpointEntityId: '12',
      state: 'running',
    });
    const finalPage = await repository.stageBackfillPage(run.id);
    expect(finalPage).toMatchObject({
      staged: 1,
      checkpointEntityId: '13',
      state: 'scanned',
    });

    const committed = await pool.query(
      `SELECT
         run.rows_scanned,
         run.pages_staged,
         count(DISTINCT staged.event_id)::int AS staged_events,
         count(delivery.id)::int AS deliveries
       FROM pipeline.backfill_runs AS run
       JOIN pipeline.backfill_run_events AS staged ON staged.run_id = run.id
       JOIN pipeline.deliveries AS delivery ON delivery.event_id = staged.event_id
       WHERE run.id = $1
       GROUP BY run.id`,
      [run.id],
    );
    expect(committed.rows[0]).toEqual({
      rows_scanned: '3',
      pages_staged: '2',
      staged_events: 3,
      deliveries: 6,
    });
  });

  it('collapses overlapping backfill and incremental acquisition into one logical event', async () => {
    const sourceSystem = testSourceSystem('overlap');
    await insertCustomers(sourceSystem, [21]);
    const run = await repository.createBackfillRun(sourceSystem, 10);

    await repository.stageBackfillPage(run.id);
    await repository.handoffOutboxBatch({ sourceSystem, limit: 10 });

    const result = await pool.query(
      `SELECT
         count(DISTINCT event.event_id)::int AS events,
         count(DISTINCT capture.event_id)::int AS captures,
         count(DISTINCT staged.event_id)::int AS backfill_events,
         count(delivery.id)::int AS deliveries
       FROM pipeline.events AS event
       LEFT JOIN pipeline.source_event_captures AS capture
         ON capture.event_id = event.event_id
       LEFT JOIN pipeline.backfill_run_events AS staged
         ON staged.event_id = event.event_id AND staged.run_id = $2
       LEFT JOIN pipeline.deliveries AS delivery
         ON delivery.event_id = event.event_id
       WHERE event.source_system = $1`,
      [sourceSystem, run.id],
    );
    expect(result.rows[0]).toEqual({
      events: 1,
      captures: 1,
      backfill_events: 1,
      deliveries: 2,
    });
  });

  it('recovers expired claims and fences a stale worker generation', async () => {
    await pool.query(
      `UPDATE pipeline.deliveries
       SET status = 'delivered',
           claim_owner = NULL,
           lease_expires_at = NULL,
           completed_at = clock_timestamp()
       WHERE status <> 'delivered'`,
    );
    const sourceSystem = testSourceSystem('claim-recovery');
    await insertCustomers(sourceSystem, [31]);
    await repository.handoffOutboxBatch({ sourceSystem, limit: 10 });

    const firstClaims = await repository.claimDeliveries({
      destination: 'elasticsearch',
      owner: 'worker-a',
      limit: 1,
      leaseMs: 30_000,
    });
    expect(firstClaims).toHaveLength(1);
    expect(firstClaims[0]).toMatchObject({
      sourceSystem,
      attemptCount: 1,
      claimGeneration: '1',
    });

    await pool.query(
      `UPDATE pipeline.deliveries
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [firstClaims[0].id],
    );
    expect(await repository.recoverExpiredClaims('elasticsearch')).toBe(1);

    const secondClaims = await repository.claimDeliveries({
      destination: 'elasticsearch',
      owner: 'worker-b',
      limit: 1,
      leaseMs: 30_000,
    });
    expect(secondClaims).toHaveLength(1);
    expect(secondClaims[0]).toMatchObject({
      id: firstClaims[0].id,
      eventId: firstClaims[0].eventId,
      attemptCount: 2,
      claimGeneration: '2',
    });

    expect(
      await repository.markDeliveryDelivered(
        firstClaims[0].id,
        'worker-a',
        firstClaims[0].claimGeneration,
      ),
    ).toBe(false);
    expect(
      await repository.markDeliveryDelivered(
        secondClaims[0].id,
        'worker-b',
        secondClaims[0].claimGeneration,
      ),
    ).toBe(true);
  });

  it('installs bounded defaults and enforces one unresolved DLQ entry per delivery', async () => {
    const settings = await pool.query(
      `SELECT key FROM pipeline.settings ORDER BY key`,
    );
    expect(settings.rows.map((row) => row.key)).toEqual([
      'backfill.page_size',
      'delivery.claim_size',
      'delivery.lease_ms',
      'incremental.batch_size',
      'retry.initial_ms',
      'retry.maximum_ms',
    ]);

    const sourceSystem = testSourceSystem('dlq-constraint');
    await insertCustomers(sourceSystem, [41]);
    await repository.handoffOutboxBatch({ sourceSystem, limit: 10 });
    const event = await pool.query(
      `SELECT event_id, canonical_payload, payload_hash
       FROM pipeline.events
       WHERE source_system = $1`,
      [sourceSystem],
    );
    const values = [
      event.rows[0].event_id,
      JSON.stringify(event.rows[0].canonical_payload),
      event.rows[0].payload_hash,
    ];
    await pool.query(
      `INSERT INTO pipeline.dlq_entries (
         event_id,
         destination,
         error_category,
         error_reason,
         original_payload,
         payload_hash,
         attempt_count
       ) VALUES ($1, 'elasticsearch', 'mapping', 'fixture rejection', $2::jsonb, $3, 1)`,
      values,
    );
    await expect(
      pool.query(
        `INSERT INTO pipeline.dlq_entries (
           event_id,
           destination,
           error_category,
           error_reason,
           original_payload,
           payload_hash,
           attempt_count
         ) VALUES ($1, 'elasticsearch', 'mapping', 'duplicate', $2::jsonb, $3, 2)`,
        values,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
