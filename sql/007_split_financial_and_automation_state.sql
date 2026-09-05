ALTER TABLE recovery_cases
  ADD COLUMN IF NOT EXISTS financial_status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (financial_status IN ('OPEN', 'RECOVERED', 'STOPPED')),
  ADD COLUMN IF NOT EXISTS automation_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (automation_status IN ('ACTIVE', 'WAITING', 'SCHEDULED', 'ESCALATED', 'EXHAUSTED', 'STOPPED'));

UPDATE recovery_cases
SET financial_status = CASE
      WHEN status = 'RECOVERED' THEN 'RECOVERED'
      WHEN status = 'STOPPED' THEN 'STOPPED'
      ELSE 'OPEN'
    END,
    automation_status = CASE
      WHEN status = 'ESCALATED' THEN 'ESCALATED'
      WHEN status = 'SCHEDULED' THEN 'SCHEDULED'
      WHEN status = 'WAITING_FOR_OUTCOME' THEN 'WAITING'
      WHEN status IN ('RECOVERED', 'STOPPED') THEN 'STOPPED'
      ELSE 'ACTIVE'
    END;

CREATE INDEX IF NOT EXISTS recovery_cases_financial_status_idx
  ON recovery_cases(financial_status);
CREATE INDEX IF NOT EXISTS recovery_cases_automation_status_idx
  ON recovery_cases(automation_status);
