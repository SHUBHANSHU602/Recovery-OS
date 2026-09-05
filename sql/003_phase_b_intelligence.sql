ALTER TABLE recovery_cases
  ADD COLUMN IF NOT EXISTS recovery_probability DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS expected_recovery_value BIGINT,
  ADD COLUMN IF NOT EXISTS priority_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS payment_promises (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  promised_amount BIGINT NOT NULL CHECK (promised_amount > 0),
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  source TEXT NOT NULL DEFAULT 'merchant_or_agent',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payment_promises_case_idx ON payment_promises(case_id, status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS payment_promises_one_pending_per_case_idx
  ON payment_promises(case_id)
  WHERE status = 'PENDING';
