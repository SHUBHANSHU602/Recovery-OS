CREATE TABLE IF NOT EXISTS recovery_cases (
  id BIGSERIAL PRIMARY KEY,
  original_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  original_payment_id TEXT,
  customer_email TEXT,
  amount_at_risk BIGINT NOT NULL DEFAULT 0,
  strategy TEXT,
  razorpay_payment_link_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'DETECTED',
  recovered_amount BIGINT NOT NULL DEFAULT 0,
  recovered_at TIMESTAMPTZ,
  evidence_cutoff_at TIMESTAMPTZ,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recovery_jobs (
  case_id BIGINT PRIMARY KEY REFERENCES recovery_cases(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbound_contacts (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT REFERENCES recovery_cases(id) ON DELETE CASCADE,
  customer_email TEXT NOT NULL,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivery_state TEXT NOT NULL DEFAULT 'accepted'
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_actions (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  intervention_id BIGINT,
  desired_action TEXT NOT NULL,
  schedule_key TEXT NOT NULL UNIQUE,
  run_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_actions_due_idx ON scheduled_actions(run_at, status);

CREATE TABLE IF NOT EXISTS human_escalations (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL UNIQUE REFERENCES recovery_cases(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: UPDATE/DELETE is not allowed';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_append_only_guard') THEN
    CREATE TRIGGER audit_log_append_only_guard
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
  END IF;
END $$;
