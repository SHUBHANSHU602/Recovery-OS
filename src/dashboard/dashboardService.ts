import type { Pool } from "pg";

const TRUSTED_RECOVERY_SQL = `
  status = 'RECOVERED'
  AND recovered_amount > 0
  AND recovered_at IS NOT NULL
  AND razorpay_payment_link_id IS NOT NULL
  AND terminal_reason = 'trusted_payment_link_paid'
`;

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function normalizeCaseRow(row: any) {
  return {
    id: asNumber(row.id),
    originalEventId: String(row.original_event_id),
    originalPaymentId: row.original_payment_id == null ? null : String(row.original_payment_id),
    customerEmail: row.customer_email == null ? null : String(row.customer_email),
    amountAtRisk: asNumber(row.amount_at_risk),
    recoveredAmount: asNumber(row.recovered_amount),
    recoveryProbability: row.recovery_probability == null ? null : Number(row.recovery_probability),
    expectedRecoveryValue: row.expected_recovery_value == null ? null : asNumber(row.expected_recovery_value),
    priorityUpdatedAt: row.priority_updated_at ?? null,
    strategy: row.strategy == null ? null : String(row.strategy),
    status: String(row.status),
    terminalReason: row.terminal_reason == null ? null : String(row.terminal_reason),
    razorpayPaymentLinkId: row.razorpay_payment_link_id == null ? null : String(row.razorpay_payment_link_id),
    recoveredAt: row.recovered_at ?? null,
    evidenceCutoffAt: row.evidence_cutoff_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rootCause: row.root_cause == null ? null : String(row.root_cause),
    confidence: row.confidence == null ? null : Number(row.confidence),
    verifierResult: row.verifier_result == null ? null : String(row.verifier_result),
    chosenAction: row.chosen_action == null ? null : String(row.chosen_action),
    finalAction: row.final_action == null ? null : String(row.final_action),
    nextRunAt: row.next_run_at ?? null,
    escalationStatus: row.escalation_status == null ? null : String(row.escalation_status),
    escalationReason: row.escalation_reason == null ? null : String(row.escalation_reason),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorDescription: row.error_description == null ? null : String(row.error_description),
    bank: row.bank == null ? null : String(row.bank),
    currency: row.currency == null ? null : String(row.currency),
    activePromise: row.promise_id == null ? null : {
      id: asNumber(row.promise_id),
      promisedAmount: asNumber(row.promised_amount),
      dueAt: row.promise_due_at,
      status: String(row.promise_status),
      source: String(row.promise_source),
      note: row.promise_note == null ? null : String(row.promise_note),
    },
  };
}

const CASE_SELECT = `
  SELECT
    rc.*,
    d.root_cause,
    d.confidence,
    d.verifier_result,
    i.chosen_action,
    i.final_action,
    sa.next_run_at,
    he.status AS escalation_status,
    he.reason AS escalation_reason,
    pp.id AS promise_id,
    pp.promised_amount,
    pp.due_at AS promise_due_at,
    pp.status AS promise_status,
    pp.source AS promise_source,
    pp.note AS promise_note,
    e.payload->'payload'->'payment'->'entity'->>'error_code' AS error_code,
    e.payload->'payload'->'payment'->'entity'->>'error_description' AS error_description,
    e.payload->'payload'->'payment'->'entity'->>'bank' AS bank,
    e.payload->'payload'->'payment'->'entity'->>'currency' AS currency
  FROM recovery_cases rc
  JOIN events e ON e.event_id = rc.original_event_id
  LEFT JOIN LATERAL (
    SELECT id, root_cause, confidence, verifier_result
    FROM diagnoses
    WHERE event_id = rc.original_event_id
    ORDER BY id DESC
    LIMIT 1
  ) d ON true
  LEFT JOIN LATERAL (
    SELECT chosen_action, final_action
    FROM interventions
    WHERE diagnosis_id = d.id
    ORDER BY id DESC
    LIMIT 1
  ) i ON true
  LEFT JOIN LATERAL (
    SELECT MIN(run_at) AS next_run_at
    FROM scheduled_actions
    WHERE case_id = rc.id AND status = 'PENDING'
  ) sa ON true
  LEFT JOIN LATERAL (
    SELECT id, promised_amount, due_at, status, source, note
    FROM payment_promises
    WHERE case_id = rc.id AND status = 'PENDING'
    ORDER BY due_at ASC
    LIMIT 1
  ) pp ON true
  LEFT JOIN human_escalations he ON he.case_id = rc.id
`;

export async function getDashboardSummary(pool: Pool) {
  const metrics = await pool.query(`
    SELECT
      COUNT(*) AS total_cases,
      COALESCE(SUM(amount_at_risk), 0) AS revenue_at_risk,
      COALESCE(SUM(expected_recovery_value) FILTER (WHERE status NOT IN ('RECOVERED', 'STOPPED', 'ESCALATED')), 0) AS expected_recovery_value,
      COALESCE(SUM(
        CASE WHEN ${TRUSTED_RECOVERY_SQL}
          THEN LEAST(amount_at_risk, recovered_amount)
          ELSE 0
        END
      ), 0) AS confirmed_recovered,
      COUNT(*) FILTER (WHERE ${TRUSTED_RECOVERY_SQL}) AS recovered_cases,
      COUNT(*) FILTER (WHERE status = 'ESCALATED') AS escalated_cases,
      COUNT(*) FILTER (WHERE status = 'WAITING_FOR_OUTCOME') AS waiting_cases,
      COUNT(*) FILTER (WHERE status = 'SCHEDULED') AS scheduled_cases,
      COUNT(*) FILTER (WHERE status NOT IN ('RECOVERED', 'STOPPED', 'ESCALATED')) AS open_cases,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM payment_promises pp WHERE pp.case_id = recovery_cases.id AND pp.status = 'PENDING')) AS active_promises
    FROM recovery_cases
  `);

  const statusResult = await pool.query(`
    SELECT status, COUNT(*) AS count
    FROM recovery_cases
    GROUP BY status
    ORDER BY count DESC, status ASC
  `);

  const strategyResult = await pool.query(`
    SELECT
      COALESCE(strategy, 'unassigned') AS strategy,
      COUNT(*) AS cases,
      COUNT(*) FILTER (WHERE ${TRUSTED_RECOVERY_SQL}) AS recovered_cases,
      COALESCE(SUM(
        CASE WHEN ${TRUSTED_RECOVERY_SQL}
          THEN LEAST(amount_at_risk, recovered_amount)
          ELSE 0
        END
      ), 0) AS recovered_amount
    FROM recovery_cases
    GROUP BY COALESCE(strategy, 'unassigned')
    ORDER BY cases DESC, strategy ASC
  `);

  const rootCauseResult = await pool.query(`
    WITH latest_diagnosis AS (
      SELECT DISTINCT ON (event_id) event_id, root_cause
      FROM diagnoses
      ORDER BY event_id, id DESC
    )
    SELECT ld.root_cause, COUNT(*) AS count
    FROM latest_diagnosis ld
    JOIN recovery_cases rc ON rc.original_event_id = ld.event_id
    GROUP BY ld.root_cause
    ORDER BY count DESC, ld.root_cause ASC
  `);

  const accuracyResult = await pool.query(`
    WITH latest_diagnosis AS (
      SELECT DISTINCT ON (event_id) event_id, root_cause
      FROM diagnoses
      ORDER BY event_id, id DESC
    ), labeled AS (
      SELECT DISTINCT ON (rb.event_id)
        rb.event_id,
        rb.ground_truth_cause,
        ld.root_cause
      FROM recovery_batches rb
      JOIN latest_diagnosis ld ON ld.event_id = rb.event_id
      ORDER BY rb.event_id, rb.id DESC
    )
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE root_cause = ground_truth_cause) AS correct
    FROM labeled
  `);

  const recentResult = await pool.query(`${CASE_SELECT} ORDER BY COALESCE(rc.expected_recovery_value, 0) DESC, rc.updated_at DESC LIMIT 6`);

  const row = metrics.rows[0] ?? {};
  const atRisk = asNumber(row.revenue_at_risk);
  const recovered = asNumber(row.confirmed_recovered);
  const labeledTotal = asNumber(accuracyResult.rows[0]?.total);
  const labeledCorrect = asNumber(accuracyResult.rows[0]?.correct);

  return {
    generatedAt: new Date().toISOString(),
    totalCases: asNumber(row.total_cases),
    revenueAtRisk: atRisk,
    expectedRecoveryValue: asNumber(row.expected_recovery_value),
    confirmedRecovered: recovered,
    valueRecoveryRate: atRisk > 0 ? (recovered / atRisk) * 100 : 0,
    recoveredCases: asNumber(row.recovered_cases),
    openCases: asNumber(row.open_cases),
    waitingCases: asNumber(row.waiting_cases),
    scheduledCases: asNumber(row.scheduled_cases),
    escalatedCases: asNumber(row.escalated_cases),
    activePromises: asNumber(row.active_promises),
    diagnosisAccuracy: labeledTotal > 0 ? (labeledCorrect / labeledTotal) * 100 : null,
    diagnosisCorrect: labeledCorrect,
    diagnosisTotal: labeledTotal,
    statuses: statusResult.rows.map((item) => ({ status: String(item.status), count: asNumber(item.count) })),
    strategies: strategyResult.rows.map((item) => ({
      strategy: String(item.strategy),
      cases: asNumber(item.cases),
      recoveredCases: asNumber(item.recovered_cases),
      recoveredAmount: asNumber(item.recovered_amount),
    })),
    rootCauses: rootCauseResult.rows.map((item) => ({ rootCause: String(item.root_cause), count: asNumber(item.count) })),
    recentCases: recentResult.rows.map(normalizeCaseRow),
  };
}

export async function listRecoveryCases(
  pool: Pool,
  options: { status?: string | null; search?: string | null; limit?: number; offset?: number } = {}
) {
  const status = options.status?.trim() || null;
  const search = options.search?.trim() || null;
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);

  const where = `
    WHERE ($1::text IS NULL OR rc.status = $1)
      AND (
        $2::text IS NULL
        OR rc.customer_email ILIKE '%' || $2 || '%'
        OR rc.original_event_id ILIKE '%' || $2 || '%'
        OR COALESCE(rc.original_payment_id, '') ILIKE '%' || $2 || '%'
      )
  `;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(`${CASE_SELECT} ${where} ORDER BY COALESCE(rc.expected_recovery_value, 0) DESC, rc.updated_at DESC LIMIT $3 OFFSET $4`, [status, search, limit, offset]),
    pool.query(`SELECT COUNT(*) FROM recovery_cases rc ${where}`, [status, search]),
  ]);

  return {
    total: asNumber(countResult.rows[0]?.count),
    limit,
    offset,
    cases: rowsResult.rows.map(normalizeCaseRow),
  };
}

export async function getRecoveryCase(pool: Pool, caseId: number) {
  const result = await pool.query(`${CASE_SELECT} WHERE rc.id = $1 LIMIT 1`, [caseId]);
  return result.rows.length === 0 ? null : normalizeCaseRow(result.rows[0]);
}

export async function getRecoveryCaseTimeline(pool: Pool, caseId: number) {
  const caseResult = await pool.query("SELECT original_event_id FROM recovery_cases WHERE id = $1", [caseId]);
  if (caseResult.rows.length === 0) return null;

  const eventId = String(caseResult.rows[0].original_event_id);
  const result = await pool.query(
    `SELECT id, stage, detail, created_at
     FROM audit_log
     WHERE event_id = $1
     ORDER BY created_at ASC, id ASC`,
    [eventId]
  );

  return {
    caseId,
    eventId,
    events: result.rows.map((row) => ({
      id: asNumber(row.id),
      stage: String(row.stage),
      detail: row.detail,
      createdAt: row.created_at,
    })),
  };
}

export async function listHumanEscalations(pool: Pool, limit = 100) {
  const boundedLimit = Math.min(200, Math.max(1, limit));
  const result = await pool.query(
    `SELECT
       he.id,
       he.case_id,
       he.reason,
       he.status,
       he.created_at,
       he.updated_at,
       he.resolved_at,
       rc.customer_email,
       rc.amount_at_risk,
       rc.expected_recovery_value,
       rc.strategy,
       rc.status AS recovery_status,
       d.root_cause,
       d.confidence
     FROM human_escalations he
     JOIN recovery_cases rc ON rc.id = he.case_id
     LEFT JOIN LATERAL (
       SELECT root_cause, confidence
       FROM diagnoses
       WHERE event_id = rc.original_event_id
       ORDER BY id DESC
       LIMIT 1
     ) d ON true
     ORDER BY
       CASE he.status WHEN 'OPEN' THEN 0 ELSE 1 END,
       COALESCE(rc.expected_recovery_value, 0) DESC,
       he.updated_at DESC
     LIMIT $1`,
    [boundedLimit]
  );

  return {
    items: result.rows.map((row) => ({
      id: asNumber(row.id),
      caseId: asNumber(row.case_id),
      customerEmail: row.customer_email == null ? null : String(row.customer_email),
      amountAtRisk: asNumber(row.amount_at_risk),
      expectedRecoveryValue: row.expected_recovery_value == null ? null : asNumber(row.expected_recovery_value),
      strategy: row.strategy == null ? null : String(row.strategy),
      recoveryStatus: String(row.recovery_status),
      reason: String(row.reason),
      status: String(row.status),
      rootCause: row.root_cause == null ? null : String(row.root_cause),
      confidence: row.confidence == null ? null : Number(row.confidence),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at ?? null,
    })),
  };
}
