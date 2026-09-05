CREATE TABLE IF NOT EXISTS channel_deliveries (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'voice')),
  recipient TEXT NOT NULL,
  message TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_deliveries_case_idx
  ON channel_deliveries(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS channel_deliveries_status_idx
  ON channel_deliveries(status, created_at DESC);
