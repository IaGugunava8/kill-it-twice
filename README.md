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

From PowerShell, the complete stack is built, started, and readiness-checked with one command:

```powershell
.\scripts\start-stack.ps1
```

On macOS, Linux, or WSL, use:

```bash
sh ./scripts/start-stack.sh
```

The startup command uses `docker compose up --build --wait` and then runs `scripts/check-stack.mjs`. It fails if a public endpoint does not become ready.

Local endpoints after startup:

- Frontend: `http://localhost:5173`
- API readiness: `http://localhost:3000/health`
- Worker readiness: `http://localhost:3001/health`
- Consumer readiness: `http://localhost:3002/health`
- PostgreSQL: `localhost:15432`
- RabbitMQ AMQP: `localhost:5672`
- RabbitMQ management: `http://localhost:15672`
- Elasticsearch: `http://localhost:9200`

The values in `infra/.env.example` are development-only credentials.

Stop the stack while retaining its named data volumes with:

```bash
docker compose --env-file infra/.env.example -f infra/docker-compose.yml down
```

Do not add `--volumes` unless deleting the local database, broker, and search data is intentional.

## Isolated verification environment

The future fault-injection verifier has a reserved Compose project and non-conflicting host ports in `infra/.env.verify.example`. It can start with:

```bash
docker compose --project-name kill-it-twice-verify --env-file infra/.env.verify.example -f infra/docker-compose.yml up -d --build --wait
```

The separate project name gives verification its own containers, network, and persistent volumes. This reservation is infrastructure only; G1–G5 are not implemented or claimed as passing yet.

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

Build the three backend applications with `npm run build`; build the frontend with its own `npm run build` command. Container builds use exact base-image versions and `npm ci` with committed lockfiles.

At this stage the applications expose process-level health endpoints and PostgreSQL has the three namespace schemas. Domain tables, replication behavior, application-level dependency probes, and the automated gates are subsequent implementation work and are not yet claimed as complete.

## Dependency audit note

The frontend runtime audit is clean. The current Nest Express adapter transitively resolves a Multer release covered by denial-of-service advisories. This scaffold does not expose multipart upload routes. npm currently proposes a breaking Nest downgrade as its automated fix, so no forced dependency rewrite has been applied; reassess the adapter version before adding file uploads or preparing a production deployment.
