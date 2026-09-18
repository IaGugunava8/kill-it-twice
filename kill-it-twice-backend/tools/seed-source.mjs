import pg from 'pg';
import { databaseUrl, readOptions } from './cli-options.mjs';
import { seedCustomers } from './source-data.mjs';

const { Pool } = pg;
const options = readOptions({
  count: 10_000,
  batchSize: 500,
  seed: 20260918,
  sourceSystem: 'optio-demo',
});
const pool = new Pool({ connectionString: databaseUrl(), max: 2 });

try {
  const startedAt = Date.now();
  const result = await seedCustomers(pool, {
    ...options,
    onBatch: ({ lastId, inserted }) => {
      if (lastId === options.count || lastId % (options.batchSize * 20) === 0) {
        console.log(`seeded through id=${lastId}; inserted in batch=${inserted}`);
      }
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
