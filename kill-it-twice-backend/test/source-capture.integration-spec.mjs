import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { mutateCustomers, seedCustomers } from '../tools/source-data.mjs';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'TEST_DATABASE_URL is required; use scripts/test-source.ps1 or scripts/test-source.sh',
  );
}

let pool;

function testSourceSystem(label) {
  return `test-${label}-${randomUUID()}`;
}

async function insertCustomer(client, sourceSystem, id, suffix = '') {
  return client.query(
    `INSERT INTO source.customers (
      source_system, id, name, email, segment, balance, attributes
    ) VALUES ($1, $2, $3, $4, 'bronze', 125.50, $5::jsonb)
    RETURNING source_system, id, version, deleted`,
    [
      sourceSystem,
      id,
      `Integration Customer ${suffix || id}`,
      `integration-${sourceSystem}-${id}@example.test`,
      JSON.stringify({ fixture: true, suffix }),
    ],
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString, max: 8 });
  const result = await pool.query(
    `SELECT to_regclass('source.customers') AS customers,
            to_regclass('source.outbox_events') AS events`,
  );
  expect(result.rows[0]).toEqual({
    customers: 'source.customers',
    events: 'source.outbox_events',
  });
});

afterAll(async () => {
  await pool.end();
});

describe('transactional source capture', () => {
  it('captures insert, update, and logical delete as canonical immutable events', async () => {
    const sourceSystem = testSourceSystem('lifecycle');
    const id = 101;

    const inserted = await insertCustomer(pool, sourceSystem, id);
    expect(inserted.rows[0]).toMatchObject({ version: '1', deleted: false });

    const updated = await pool.query(
      `UPDATE source.customers
       SET name = 'Updated Customer', balance = 999.25
       WHERE source_system = $1 AND id = $2
       RETURNING version, deleted`,
      [sourceSystem, id],
    );
    expect(updated.rows[0]).toMatchObject({ version: '2', deleted: false });

    const deleted = await pool.query(
      'SELECT source.delete_customer($1, $2) AS changed',
      [id, sourceSystem],
    );
    expect(deleted.rows[0].changed).toBe(true);

    const state = await pool.query(
      `SELECT entity_version, operation, canonical_payload, payload_hash
       FROM source.customer_state_oracle
       WHERE source_system = $1 AND entity_id = $2`,
      [sourceSystem, String(id)],
    );
    expect(state.rows[0]).toMatchObject({
      entity_version: '3',
      operation: 'delete',
    });
    expect(state.rows[0].canonical_payload).toMatchObject({
      deleted: true,
      entityId: String(id),
      sourceSystem,
      version: '3',
    });

    const events = await pool.query(
      `SELECT event_id, entity_version, operation, canonical_payload, payload_hash,
              source.payload_sha256(canonical_payload) AS calculated_hash
       FROM source.event_oracle
       WHERE source_system = $1 AND entity_id = $2
       ORDER BY entity_version`,
      [sourceSystem, String(id)],
    );
    expect(events.rows).toHaveLength(3);
    expect(events.rows.map(({ event_id, operation }) => ({ event_id, operation }))).toEqual([
      { event_id: `${sourceSystem}:customer:${id}:1`, operation: 'upsert' },
      { event_id: `${sourceSystem}:customer:${id}:2`, operation: 'upsert' },
      { event_id: `${sourceSystem}:customer:${id}:3`, operation: 'delete' },
    ]);
    for (const event of events.rows) {
      expect(event.payload_hash).toBe(event.calculated_hash);
      expect(event.canonical_payload.version).toBe(event.entity_version);
    }

    await expect(
      pool.query(
        `UPDATE source.outbox_events SET operation = 'delete'
         WHERE event_id = $1`,
        [events.rows[0].event_id],
      ),
    ).rejects.toThrow(/outbox events are immutable/);

    await expect(
      pool.query(
        'DELETE FROM source.customers WHERE source_system = $1 AND id = $2',
        [sourceSystem, id],
      ),
    ).rejects.toThrow(/hard delete is disabled/);
  });

  it('removes both source state and its event when a transaction rolls back', async () => {
    const sourceSystem = testSourceSystem('rollback');
    const id = 201;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await insertCustomer(client, sourceSystem, id);
      const visibleInside = await client.query(
        `SELECT count(*)::int AS count FROM source.outbox_events
         WHERE source_system = $1`,
        [sourceSystem],
      );
      expect(visibleInside.rows[0].count).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const committed = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM source.customers WHERE source_system = $1) AS customers,
        (SELECT count(*)::int FROM source.outbox_events WHERE source_system = $1) AS events`,
      [sourceSystem],
    );
    expect(committed.rows[0]).toEqual({ customers: 0, events: 0 });
  });

  it('captures both overlapping transactions even when sequence and commit order differ', async () => {
    const sourceSystem = testSourceSystem('overlap');
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();

    try {
      await firstClient.query('BEGIN');
      await insertCustomer(firstClient, sourceSystem, 301, 'first');
      const firstPosition = await firstClient.query(
        `SELECT position FROM source.outbox_events
         WHERE source_system = $1 AND entity_id = '301'`,
        [sourceSystem],
      );

      await secondClient.query('BEGIN');
      await insertCustomer(secondClient, sourceSystem, 302, 'second');
      const secondPosition = await secondClient.query(
        `SELECT position FROM source.outbox_events
         WHERE source_system = $1 AND entity_id = '302'`,
        [sourceSystem],
      );

      expect(BigInt(firstPosition.rows[0].position)).toBeLessThan(
        BigInt(secondPosition.rows[0].position),
      );

      await secondClient.query('COMMIT');
      const afterSecondCommit = await pool.query(
        `SELECT entity_id FROM source.outbox_events
         WHERE source_system = $1 ORDER BY entity_id`,
        [sourceSystem],
      );
      expect(afterSecondCommit.rows.map((row) => row.entity_id)).toEqual(['302']);

      await firstClient.query('COMMIT');
    } catch (error) {
      await firstClient.query('ROLLBACK').catch(() => {});
      await secondClient.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      firstClient.release();
      secondClient.release();
    }

    const afterBothCommits = await pool.query(
      `SELECT entity_id FROM source.outbox_events
       WHERE source_system = $1 ORDER BY entity_id`,
      [sourceSystem],
    );
    expect(afterBothCommits.rows.map((row) => row.entity_id)).toEqual(['301', '302']);
  });
});

describe('bounded deterministic generators', () => {
  it('streams deterministic seed batches and captures every inserted seed record', async () => {
    const sourceSystem = testSourceSystem('seed');
    const firstRun = await seedCustomers(pool, {
      count: 7,
      batchSize: 3,
      seed: 42,
      sourceSystem,
    });
    expect(firstRun).toEqual({ attempted: 7, inserted: 7, peakBatchSize: 3 });

    const secondRun = await seedCustomers(pool, {
      count: 7,
      batchSize: 3,
      seed: 42,
      sourceSystem,
    });
    expect(secondRun).toEqual({ attempted: 7, inserted: 0, peakBatchSize: 3 });

    const captured = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM source.customers WHERE source_system = $1) AS customers,
        (SELECT count(*)::int FROM source.outbox_events WHERE source_system = $1) AS events,
        (SELECT count(*)::int FROM source.outbox_events
          WHERE source_system = $1 AND entity_version = 1) AS version_one_events`,
      [sourceSystem],
    );
    expect(captured.rows[0]).toEqual({
      customers: 7,
      events: 7,
      version_one_events: 7,
    });
  });

  it('generates bounded deterministic inserts, updates, and deletes', async () => {
    const sourceSystem = testSourceSystem('mutations');
    await seedCustomers(pool, {
      count: 20,
      batchSize: 5,
      seed: 77,
      sourceSystem,
    });

    const result = await mutateCustomers(pool, {
      count: 12,
      baseCount: 20,
      batchSize: 4,
      seed: 77,
      sourceSystem,
    });
    expect(result).toEqual({ attempted: 12, committedEvents: 12, peakBatchSize: 4 });

    const captured = await pool.query(
      `SELECT
        count(*)::int AS events,
        count(*) FILTER (WHERE operation = 'delete')::int AS deletes,
        count(DISTINCT event_id)::int AS unique_events
       FROM source.outbox_events WHERE source_system = $1`,
      [sourceSystem],
    );
    expect(captured.rows[0]).toEqual({ events: 32, deletes: 2, unique_events: 32 });
  });
});
