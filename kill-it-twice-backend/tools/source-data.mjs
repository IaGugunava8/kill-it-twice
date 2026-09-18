const SEGMENTS = ['bronze', 'silver', 'gold', 'platinum'];
const REGIONS = ['apac', 'emea', 'latam', 'north-america'];

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function normalizeSeed(seed) {
  requirePositiveInteger(seed, 'seed');
  return seed >>> 0;
}

function mix32(value) {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

export function deterministicCustomer(id, seed = 20260918) {
  requirePositiveInteger(id, 'id');
  const normalizedSeed = normalizeSeed(seed);
  const hash = mix32((id ^ normalizedSeed) >>> 0);
  const paddedId = String(id).padStart(10, '0');

  return {
    id,
    name: `Customer ${paddedId}`,
    email: `customer-${normalizedSeed}-${paddedId}@example.test`,
    segment: SEGMENTS[hash % SEGMENTS.length],
    balance: (((hash % 9_000_000) + 100_000) / 100).toFixed(2),
    attributes: {
      region: REGIONS[(hash >>> 3) % REGIONS.length],
      riskScore: (hash >>> 7) % 101,
      seed: normalizedSeed,
    },
  };
}

export async function seedCustomers(
  pool,
  {
    count,
    batchSize = 500,
    seed = 20260918,
    sourceSystem = 'optio-demo',
    onBatch = () => {},
  },
) {
  requirePositiveInteger(count, 'count');
  requirePositiveInteger(batchSize, 'batchSize');
  normalizeSeed(seed);

  let inserted = 0;
  let peakBatchSize = 0;

  for (let firstId = 1; firstId <= count; firstId += batchSize) {
    const currentBatchSize = Math.min(batchSize, count - firstId + 1);
    peakBatchSize = Math.max(peakBatchSize, currentBatchSize);
    const placeholders = [];
    const parameters = [];

    for (let offset = 0; offset < currentBatchSize; offset += 1) {
      const customer = deterministicCustomer(firstId + offset, seed);
      const parameterOffset = offset * 7;
      placeholders.push(
        `($${parameterOffset + 1}, $${parameterOffset + 2}, $${parameterOffset + 3}, ` +
          `$${parameterOffset + 4}, $${parameterOffset + 5}, $${parameterOffset + 6}, ` +
          `$${parameterOffset + 7}::jsonb)`,
      );
      parameters.push(
        sourceSystem,
        customer.id,
        customer.name,
        customer.email,
        customer.segment,
        customer.balance,
        JSON.stringify(customer.attributes),
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO source.customers (
          source_system, id, name, email, segment, balance, attributes
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (source_system, id) DO NOTHING`,
        parameters,
      );
      await client.query('COMMIT');
      inserted += result.rowCount ?? 0;
      onBatch({
        firstId,
        lastId: firstId + currentBatchSize - 1,
        attempted: currentBatchSize,
        inserted: result.rowCount ?? 0,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { attempted: count, inserted, peakBatchSize };
}

function mutationInsertId(index, seed) {
  return 5_000_000_000 + (normalizeSeed(seed) % 1_000) * 1_000_000 + index;
}

export async function mutateCustomers(
  pool,
  {
    count,
    baseCount,
    batchSize = 100,
    seed = 20260918,
    sourceSystem = 'optio-demo',
    intervalMs = 0,
    onBatch = () => {},
  },
) {
  requirePositiveInteger(count, 'count');
  requirePositiveInteger(baseCount, 'baseCount');
  requirePositiveInteger(batchSize, 'batchSize');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    throw new Error('intervalMs must be a non-negative safe integer');
  }

  const updateRange = Math.max(1, Math.floor(baseCount * 0.75));
  const deleteRange = Math.max(1, baseCount - updateRange);
  let committedEvents = 0;
  let peakBatchSize = 0;

  for (let first = 0; first < count; first += batchSize) {
    const currentBatchSize = Math.min(batchSize, count - first);
    peakBatchSize = Math.max(peakBatchSize, currentBatchSize);
    const client = await pool.connect();
    let batchEvents = 0;

    try {
      await client.query('BEGIN');
      for (let offset = 0; offset < currentBatchSize; offset += 1) {
        const mutationIndex = first + offset;
        const action = mutationIndex % 10;

        if (action < 6) {
          const id = 1 + (mutationIndex % updateRange);
          const result = await client.query(
            `UPDATE source.customers
             SET balance = balance + $3::numeric,
                 segment = $4,
                 attributes = attributes || jsonb_build_object('lastMutation', $5::bigint)
             WHERE source_system = $1 AND id = $2 AND deleted = FALSE`,
            [
              sourceSystem,
              id,
              ((mutationIndex % 97) + 1).toFixed(2),
              SEGMENTS[(mutationIndex + normalizeSeed(seed)) % SEGMENTS.length],
              mutationIndex,
            ],
          );
          batchEvents += result.rowCount ?? 0;
          continue;
        }

        if (action < 8) {
          const id = mutationInsertId(mutationIndex, seed);
          const customer = deterministicCustomer(id, seed);
          const result = await client.query(
            `INSERT INTO source.customers (
              source_system, id, name, email, segment, balance, attributes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
            ON CONFLICT (source_system, id) DO NOTHING`,
            [
              sourceSystem,
              id,
              customer.name,
              customer.email,
              customer.segment,
              customer.balance,
              JSON.stringify(customer.attributes),
            ],
          );
          batchEvents += result.rowCount ?? 0;
          continue;
        }

        const id = baseCount - (mutationIndex % deleteRange);
        const result = await client.query(
          'SELECT source.delete_customer($1, $2) AS changed',
          [id, sourceSystem],
        );
        batchEvents += result.rows[0]?.changed ? 1 : 0;
      }

      await client.query('COMMIT');
      committedEvents += batchEvents;
      onBatch({
        firstMutation: first + 1,
        lastMutation: first + currentBatchSize,
        attempted: currentBatchSize,
        committedEvents: batchEvents,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (intervalMs > 0 && first + currentBatchSize < count) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return { attempted: count, committedEvents, peakBatchSize };
}
