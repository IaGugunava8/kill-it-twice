ALTER TABLE source.customers
  DROP CONSTRAINT IF EXISTS customers_positive_id;
ALTER TABLE source.customers
  ADD CONSTRAINT customers_positive_id CHECK (id > 0);

CREATE TABLE IF NOT EXISTS pipeline.backfill_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system TEXT NOT NULL CHECK (length(btrim(source_system)) > 0),
  state TEXT NOT NULL DEFAULT 'created'
    CHECK (state IN (
      'created',
      'running',
      'paused',
      'scanned',
      'completed',
      'completed_with_errors',
      'failed'
    )),
  scan_boundary BIGINT NOT NULL CHECK (scan_boundary >= 0),
  checkpoint_entity_id BIGINT NOT NULL DEFAULT 0
    CHECK (checkpoint_entity_id >= 0),
  page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 10000),
  rows_scanned BIGINT NOT NULL DEFAULT 0 CHECK (rows_scanned >= 0),
  pages_staged BIGINT NOT NULL DEFAULT 0 CHECK (pages_staged >= 0),
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  scanned_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error JSONB,
  CHECK (checkpoint_entity_id <= scan_boundary)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_backfill_per_source_idx
  ON pipeline.backfill_runs (source_system)
  WHERE state IN ('created', 'running', 'paused', 'scanned');

CREATE TABLE IF NOT EXISTS pipeline.events (
  event_id TEXT PRIMARY KEY,
  schema_version SMALLINT NOT NULL CHECK (schema_version > 0),
  source_system TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version BIGINT NOT NULL CHECK (entity_version > 0),
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  source_timestamp TIMESTAMPTZ NOT NULL,
  canonical_payload JSONB NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  first_acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_system, entity_type, entity_id, entity_version)
);

CREATE INDEX IF NOT EXISTS pipeline_events_entity_history_idx
  ON pipeline.events (source_system, entity_type, entity_id, entity_version);

CREATE TABLE IF NOT EXISTS pipeline.source_event_captures (
  event_id TEXT PRIMARY KEY REFERENCES pipeline.events(event_id),
  outbox_position BIGINT NOT NULL UNIQUE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS pipeline.backfill_run_events (
  run_id UUID NOT NULL REFERENCES pipeline.backfill_runs(id),
  event_id TEXT NOT NULL REFERENCES pipeline.events(event_id),
  source_entity_id BIGINT NOT NULL CHECK (source_entity_id > 0),
  staged_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, event_id),
  UNIQUE (run_id, source_entity_id)
);

CREATE INDEX IF NOT EXISTS backfill_run_events_event_idx
  ON pipeline.backfill_run_events (event_id);

CREATE TABLE IF NOT EXISTS pipeline.deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES pipeline.events(event_id),
  destination TEXT NOT NULL CHECK (destination IN ('elasticsearch', 'rabbitmq')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',
      'in_flight',
      'retry_scheduled',
      'delivered',
      'superseded',
      'quarantined'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  claim_owner TEXT,
  claim_generation BIGINT NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  lease_expires_at TIMESTAMPTZ,
  last_error JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, destination),
  CHECK (
    (status = 'in_flight' AND claim_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'in_flight' AND claim_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS deliveries_ready_idx
  ON pipeline.deliveries (destination, next_attempt_at, id)
  WHERE status IN ('pending', 'retry_scheduled');

CREATE INDEX IF NOT EXISTS deliveries_expired_lease_idx
  ON pipeline.deliveries (lease_expires_at, id)
  WHERE status = 'in_flight';

CREATE TABLE IF NOT EXISTS pipeline.settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO pipeline.settings (key, value, description) VALUES
  ('backfill.page_size', '500'::jsonb, 'Maximum source rows staged per backfill page'),
  ('incremental.batch_size', '500'::jsonb, 'Maximum source outbox events handed off per transaction'),
  ('delivery.claim_size', '100'::jsonb, 'Maximum delivery rows claimed per worker transaction'),
  ('delivery.lease_ms', '30000'::jsonb, 'Initial delivery claim lease duration in milliseconds'),
  ('retry.initial_ms', '1000'::jsonb, 'Initial retry delay in milliseconds'),
  ('retry.maximum_ms', '30000'::jsonb, 'Maximum retry delay in milliseconds')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS pipeline.dlq_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL REFERENCES pipeline.events(event_id),
  destination TEXT NOT NULL CHECK (destination IN ('elasticsearch', 'rabbitmq')),
  status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (status IN ('unresolved', 'resolved', 'superseded')),
  error_category TEXT NOT NULL,
  error_code TEXT,
  error_reason TEXT NOT NULL,
  original_payload JSONB NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  replay_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_unresolved_dlq_entry_per_delivery_idx
  ON pipeline.dlq_entries (event_id, destination)
  WHERE status = 'unresolved';

CREATE INDEX IF NOT EXISTS dlq_entries_status_destination_idx
  ON pipeline.dlq_entries (status, destination, created_at);

CREATE OR REPLACE FUNCTION pipeline.reject_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'canonical pipeline events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS pipeline_events_immutable ON pipeline.events;
CREATE TRIGGER pipeline_events_immutable
BEFORE UPDATE OR DELETE ON pipeline.events
FOR EACH ROW EXECUTE FUNCTION pipeline.reject_event_mutation();

COMMENT ON TABLE pipeline.backfill_runs IS
  'Durable backfill scan boundary, checkpoint, and lifecycle state';
COMMENT ON TABLE pipeline.events IS
  'Canonical logical events shared by every acquisition mode and destination';
COMMENT ON TABLE pipeline.source_event_captures IS
  'Immutable source-outbox handoff receipts; replaces mutation of source history';
COMMENT ON TABLE pipeline.backfill_run_events IS
  'Events durably staged by each backfill run before its checkpoint advances';
COMMENT ON TABLE pipeline.deliveries IS
  'Independent per-destination state, retry schedule, fencing generation, and lease';
COMMENT ON TABLE pipeline.dlq_entries IS
  'Durable contextual quarantine records for permanent destination failures';
