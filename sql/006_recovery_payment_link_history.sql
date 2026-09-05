CREATE TABLE IF NOT EXISTS recovery_payment_links (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES recovery_cases(id) ON DELETE CASCADE,
  payment_link_id TEXT NOT NULL UNIQUE,
  action_id BIGINT REFERENCES actions(id) ON DELETE SET NULL,
  short_url TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'PAID', 'CANCELLED', 'EXPIRED')),
  provider_status TEXT,
  amount BIGINT,
  amount_paid BIGINT NOT NULL DEFAULT 0,
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recovery_payment_links_case_idx
  ON recovery_payment_links(case_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS recovery_payment_links_one_active_per_case_idx
  ON recovery_payment_links(case_id)
  WHERE status = 'ACTIVE';

-- Backfill every historical successful Payment Link we can causally associate with a
-- recovery case. Legacy links are resolved through the current link id, their
-- intervention/diagnosis event, or the event-id prefix used in old idempotency keys.
WITH resolved_links AS (
  SELECT
    a.id AS action_id,
    a.response->>'id' AS payment_link_id,
    a.response->>'short_url' AS short_url,
    a.response->>'status' AS provider_status,
    NULLIF(a.response->>'amount', '')::bigint AS amount,
    COALESCE(NULLIF(a.response->>'amount_paid', '')::bigint, 0) AS amount_paid,
    a.created_at,
    COALESCE(rc_by_link.id, rc_by_intervention.id, rc_by_prefix.id) AS case_id,
    COALESCE(rc_by_link.status, rc_by_intervention.status, rc_by_prefix.status) AS case_status,
    COALESCE(rc_by_link.recovered_at, rc_by_intervention.recovered_at, rc_by_prefix.recovered_at) AS recovered_at,
    COALESCE(
      rc_by_link.razorpay_payment_link_id,
      rc_by_intervention.razorpay_payment_link_id,
      rc_by_prefix.razorpay_payment_link_id
    ) AS current_link_id
  FROM actions a
  LEFT JOIN interventions i ON i.id = a.intervention_id
  LEFT JOIN diagnoses d ON d.id = i.diagnosis_id
  LEFT JOIN recovery_cases rc_by_link
    ON rc_by_link.razorpay_payment_link_id = a.response->>'id'
  LEFT JOIN recovery_cases rc_by_intervention
    ON rc_by_intervention.original_event_id = d.event_id
  LEFT JOIN LATERAL (
    SELECT e.event_id
    FROM events e
    WHERE a.idempotency_key LIKE e.event_id || '%'
    ORDER BY length(e.event_id) DESC
    LIMIT 1
  ) matched ON true
  LEFT JOIN recovery_cases rc_by_prefix
    ON rc_by_prefix.original_event_id = matched.event_id
  WHERE a.razorpay_api_call = 'payment_links.create'
    AND a.status = 'success'
    AND a.response->>'id' IS NOT NULL
), ranked_links AS (
  SELECT
    resolved_links.*,
    row_number() OVER (
      PARTITION BY case_id
      ORDER BY
        CASE WHEN current_link_id = payment_link_id THEN 0 ELSE 1 END,
        created_at DESC,
        action_id DESC
    ) AS link_rank
  FROM resolved_links
  WHERE case_id IS NOT NULL
)
INSERT INTO recovery_payment_links (
  case_id,
  payment_link_id,
  action_id,
  short_url,
  status,
  provider_status,
  amount,
  amount_paid,
  paid_at,
  created_at,
  updated_at
)
SELECT
  case_id,
  payment_link_id,
  action_id,
  short_url,
  CASE
    WHEN case_status = 'RECOVERED' AND current_link_id = payment_link_id THEN 'PAID'
    WHEN case_status IN ('RECOVERED', 'STOPPED') THEN 'SUPERSEDED'
    WHEN link_rank = 1 THEN 'ACTIVE'
    ELSE 'SUPERSEDED'
  END,
  provider_status,
  amount,
  CASE
    WHEN case_status = 'RECOVERED' AND current_link_id = payment_link_id
      THEN GREATEST(amount_paid, COALESCE(amount, 0))
    ELSE amount_paid
  END,
  CASE
    WHEN case_status = 'RECOVERED' AND current_link_id = payment_link_id THEN recovered_at
    ELSE NULL
  END,
  created_at,
  now()
FROM ranked_links
ON CONFLICT (payment_link_id) DO NOTHING;

-- Preserve a legacy current link even if its original action row cannot be resolved.
INSERT INTO recovery_payment_links (
  case_id,
  payment_link_id,
  status,
  amount,
  amount_paid,
  paid_at,
  created_at,
  updated_at
)
SELECT
  rc.id,
  rc.razorpay_payment_link_id,
  CASE
    WHEN rc.status = 'RECOVERED' THEN 'PAID'
    WHEN rc.status = 'STOPPED' THEN 'SUPERSEDED'
    ELSE 'ACTIVE'
  END,
  rc.amount_at_risk,
  CASE WHEN rc.status = 'RECOVERED' THEN rc.recovered_amount ELSE 0 END,
  CASE WHEN rc.status = 'RECOVERED' THEN rc.recovered_at ELSE NULL END,
  rc.created_at,
  now()
FROM recovery_cases rc
WHERE rc.razorpay_payment_link_id IS NOT NULL
ON CONFLICT (payment_link_id) DO NOTHING;
