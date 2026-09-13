CREATE SCHEMA IF NOT EXISTS source;
CREATE SCHEMA IF NOT EXISTS pipeline;
CREATE SCHEMA IF NOT EXISTS consumer;

COMMENT ON SCHEMA source IS 'Relational source records and immutable source outbox';
COMMENT ON SCHEMA pipeline IS 'Replication runs, checkpoints, delivery state, and DLQ';
COMMENT ON SCHEMA consumer IS 'Independent event consumer inbox and projection';
