import { connect } from 'node:net';

const settings = {
  api: process.env.API_URL ?? 'http://127.0.0.1:3000/health',
  worker: process.env.WORKER_URL ?? 'http://127.0.0.1:3001/health',
  consumer: process.env.CONSUMER_URL ?? 'http://127.0.0.1:3002/health',
  frontend: process.env.FRONTEND_URL ?? 'http://127.0.0.1:5173/health',
  elasticsearch:
    process.env.ELASTICSEARCH_URL ?? 'http://127.0.0.1:9200/_cluster/health',
  rabbitmq:
    process.env.RABBITMQ_MANAGEMENT_URL ??
    'http://127.0.0.1:15672/api/health/checks/alarms',
  rabbitmqUser: process.env.RABBITMQ_USER ?? 'optio',
  rabbitmqPassword: process.env.RABBITMQ_PASSWORD ?? 'optio-local',
  postgresHost: process.env.POSTGRES_HOST ?? '127.0.0.1',
  postgresPort: Number(process.env.POSTGRES_PORT ?? 15432),
};

const deadline = Date.now() + Number(process.env.STACK_CHECK_TIMEOUT_MS ?? 120_000);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(name, probe) {
  let lastError;

  while (Date.now() < deadline) {
    try {
      await probe();
      console.log(`${name.padEnd(18, '.')} PASS`);
      return;
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }

  throw new Error(`${name} did not become ready: ${lastError?.message ?? 'unknown error'}`);
}

async function expectJson(url, predicate, headers = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  const body = await response.json();
  if (!predicate(body)) {
    throw new Error(`${url} returned an unexpected body`);
  }
}

function expectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(3_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`${host}:${port} timed out`));
    });
    socket.once('error', reject);
  });
}

await waitFor('PostgreSQL', () =>
  expectTcp(settings.postgresHost, settings.postgresPort),
);
await waitFor('RabbitMQ', () =>
  expectJson(
    settings.rabbitmq,
    (body) => body.status === 'ok',
    {
      Authorization: `Basic ${Buffer.from(
        `${settings.rabbitmqUser}:${settings.rabbitmqPassword}`,
      ).toString('base64')}`,
    },
  ),
);
await waitFor('Elasticsearch', () =>
  expectJson(
    settings.elasticsearch,
    (body) => body.status === 'yellow' || body.status === 'green',
  ),
);

for (const [service, url] of [
  ['API', settings.api],
  ['Worker', settings.worker],
  ['Consumer', settings.consumer],
]) {
  await waitFor(service, () =>
    expectJson(
      url,
      (body) => body.service === service.toLowerCase() && body.status === 'ok',
    ),
  );
}

await waitFor('Frontend', () =>
  expectJson(settings.frontend, (body) => body.status === 'ok'),
);

console.log('Step 2 stack readiness ........ PASS');
