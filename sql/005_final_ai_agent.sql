ALTER TABLE recovery_jobs
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'INITIAL',
  ADD COLUMN IF NOT EXISTS replan_trigger TEXT,
  ADD COLUMN IF NOT EXISTS replan_observation JSONB;

CREATE TABLE IF NOT EXISTS recovery_plans (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  trigger TEXT NOT NULL,
  objective TEXT NOT NULL,
  primary_action TEXT NOT NULL,
  fallback_action TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  escalation_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  stop_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  strategy_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  observation JSONB,
  policy_result TEXT NOT NULL,
  policy_final_action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, version)
);

CREATE INDEX IF NOT EXISTS recovery_plans_case_idx
  ON recovery_plans(case_id, version DESC);
