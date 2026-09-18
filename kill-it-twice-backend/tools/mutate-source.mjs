import pg from 'pg';
import { databaseUrl, readOptions } from './cli-options.mjs';
import { mutateCustomers } from './source-data.mjs';

const { Pool } = pg;
const options = readOptions({
  count: 1_000,
  baseCount: 10_000,
  batchSize: 100,
  seed: 20260918,
  sourceSystem: 'optio-demo',
  intervalMs: 0,
});
const pool = new Pool({ connectionString: databaseUrl(), max: 2 });

try {
  const startedAt = Date.now();
  const result = await mutateCustomers(pool, {
    ...options,
    onBatch: ({ lastMutation, committedEvents }) => {
      console.log(
        `mutated through operation=${lastMutation}; committed events in batch=${committedEvents}`,
      );
    },
  });

  console.log(
    JSON.stringify(
      { ...result, durationMs: Date.now() - startedAt, ...options },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
