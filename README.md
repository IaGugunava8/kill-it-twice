# Kill It Twice

Reliable source-to-search-and-event-stream replication assignment.

## Workspace

- `kill-it-twice-backend/apps/api`: control and query API, default port 3000
- `kill-it-twice-backend/apps/worker`: replication worker, default health port 3001
- `kill-it-twice-backend/apps/consumer`: independent event consumer, default health port 3002
- `kill-it-twice-backend/libs`: shared contracts, database names, and observability helpers
- `kill-it-twice-frontend`: React/Vite UI, default development port 5173
- `infra`: local PostgreSQL, RabbitMQ, and Elasticsearch dependencies
- `docs/operating-contract.md`: accepted correctness and verification contract

## Local dependencies

Docker Desktop and Node.js 22.22.3 or newer are required. The repository `.nvmrc` selects the intended Node version. The first infrastructure start downloads the PostgreSQL, RabbitMQ, and Elasticsearch images.

```bash
docker compose --env-file infra/.env.example -f infra/docker-compose.yml up -d
```

Local endpoints:

- PostgreSQL: `localhost:5432`
- RabbitMQ AMQP: `localhost:5672`
- RabbitMQ management: `http://localhost:15672`
- Elasticsearch: `http://localhost:9200`

The values in `infra/.env.example` are development-only credentials.

## Applications

Install dependencies in each JavaScript workspace, then run the desired process:

```bash
cd kill-it-twice-backend
npm install
npm run start:dev:api
npm run start:dev:worker
npm run start:dev:consumer
```

Run each watch process in its own terminal. Start the frontend separately:

```bash
cd kill-it-twice-frontend
npm install
npm run dev
```

Build the three backend applications with `npm run build`; build the frontend with its own `npm run build` command.

At this stage the applications expose process-level health endpoints. Database schemas, replication behavior, dependency probes, and the automated gates are subsequent implementation work and are not yet claimed as complete.

## Dependency audit note

The frontend runtime audit is clean. The current Nest Express adapter transitively resolves a Multer release covered by denial-of-service advisories. This scaffold does not expose multipart upload routes. npm currently proposes a breaking Nest downgrade as its automated fix, so no forced dependency rewrite has been applied; reassess the adapter version before adding file uploads or preparing a production deployment.
