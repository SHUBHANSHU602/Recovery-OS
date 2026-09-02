BEGIN;

ALTER TABLE actions
  ALTER COLUMN intervention_id DROP NOT NULL;

ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS event_id TEXT REFERENCES events(event_id),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE actions a
SET event_id = d.event_id
FROM interventions i
JOIN diagnoses d ON d.id = i.diagnosis_id
WHERE a.intervention_id = i.id
  AND a.event_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_actions_event_id ON actions(event_id);

CREATE TABLE IF NOT EXISTS recoveries (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  source_webhook_event_id TEXT NOT NULL UNIQUE,
  payment_link_id TEXT,
  payment_id TEXT,
  recovered_amount BIGINT NOT NULL CHECK (recovered_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  raw_payload JSONB NOT NULL,
  recovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recoveries_recovered_at ON recoveries(recovered_at);

CREATE TABLE IF NOT EXISTS scheduled_recovery_actions (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  intervention_id INTEGER REFERENCES interventions(id),
  action_type TEXT NOT NULL,
  execute_after TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, action_type)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_recovery_due
  ON scheduled_recovery_actions(status, execute_after);

COMMIT;
