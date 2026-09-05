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
    financialStatus: row.financial_status == null ? null : String(row.financial_status),
    automationStatus: row.automation_status == null ? null : String(row.automation_status),
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
    recoveryPlan: row.plan_version == null ? null : {
      version: asNumber(row.plan_version),
      trigger: String(row.plan_trigger),
      objective: String(row.plan_objective),
      primaryAction: String(row.plan_primary_action),
      fallbackAction: String(row.plan_fallback_action),
      reasoning: String(row.plan_reasoning),
      escalationCriteria: Array.isArray(row.plan_escalation_criteria) ? row.plan_escalation_criteria : [],
      stopConditions: Array.isArray(row.plan_stop_conditions) ? row.plan_stop_conditions : [],
      policyResult: String(row.plan_policy_result),
      policyFinalAction: String(row.plan_policy_final_action),
    },
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
    rp.version AS plan_version,
    rp.trigger AS plan_trigger,
    rp.objective AS plan_objective,
    rp.primary_action AS plan_primary_action,
    rp.fallback_action AS plan_fallback_action,
    rp.reasoning AS plan_reasoning,
    rp.escalation_criteria AS plan_escalation_criteria,
    rp.stop_conditions AS plan_stop_conditions,
    rp.policy_result AS plan_policy_result,
    rp.policy_final_action AS plan_policy_final_action,
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
    SELECT version, trigger, objective, primary_action, fallback_action, reasoning,
           escalation_criteria, stop_conditions, policy_result, policy_final_action
    FROM recovery_plans
    WHERE case_id = rc.id
    ORDER BY version DESC
    LIMIT 1
  ) rp ON true
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
      COALESCE(SUM(expected_recovery_value) FILTER (WHERE financial_status = 'OPEN'), 0) AS expected_recovery_value,
      COALESCE(SUM(CASE WHEN ${TRUSTED_RECOVERY_SQL} THEN LEAST(amount_at_risk, recovered_amount) ELSE 0 END), 0) AS confirmed_recovered,
      COUNT(*) FILTER (WHERE ${TRUSTED_RECOVERY_SQL}) AS recovered_cases,
      COUNT(*) FILTER (WHERE automation_status = 'ESCALATED') AS escalated_cases,
      COUNT(*) FILTER (WHERE automation_status = 'WAITING') AS waiting_cases,
      COUNT(*) FILTER (WHERE automation_status = 'SCHEDULED') AS scheduled_cases,
      COUNT(*) FILTER (WHERE financial_status = 'OPEN') AS open_cases,
      COUNT(*) FILTER (WHERE financial_status = 'STOPPED') AS stopped_cases,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM payment_promises pp WHERE pp.case_id = recovery_cases.id AND pp.status = 'PENDING')) AS active_promises
    FROM recovery_cases
  `);

  const executionMetrics = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'success') AS successful_actions,
      COUNT(*) FILTER (WHERE razorpay_api_call = 'payment_links.create' AND status = 'success') AS payment_links_created
    FROM actions
  `);
  const contactMetrics = await pool.query(`SELECT COUNT(*) AS contacts FROM outbound_contacts`);
  const linkMetrics = await pool.query(`
    SELECT
      COUNT(*) AS tracked_links,
      COUNT(*) FILTER (WHERE status = 'ACTIVE') AS active_links,
      COUNT(*) FILTER (WHERE status = 'PAID') AS paid_links,
      COUNT(*) FILTER (WHERE status IN ('CANCELLED','EXPIRED','SUPERSEDED')) AS inactive_links
    FROM recovery_payment_links
  `);

  const statusResult = await pool.query(`
    SELECT financial_status, automation_status, COUNT(*) AS count
    FROM recovery_cases
    GROUP BY financial_status, automation_status
    ORDER BY count DESC, financial_status, automation_status
  `);

  const strategyResult = await pool.query(`
    SELECT
      COALESCE(rc.strategy, 'unassigned') AS strategy,
      COUNT(*) AS cases,
      COUNT(*) FILTER (WHERE ${TRUSTED_RECOVERY_SQL}) AS recovered_cases,
      COALESCE(SUM(CASE WHEN ${TRUSTED_RECOVERY_SQL} THEN LEAST(rc.amount_at_risk, rc.recovered_amount) ELSE 0 END), 0) AS recovered_amount,
      COALESCE(AVG(COALESCE(a.attempts, 0)), 0) AS average_attempts
    FROM recovery_cases rc
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::numeric AS attempts
      FROM actions act
      LEFT JOIN interventions i ON i.id = act.intervention_id
      LEFT JOIN diagnoses d ON d.id = i.diagnosis_id
      WHERE d.event_id = rc.original_event_id
         OR starts_with(act.idempotency_key, rc.original_event_id || '_')
    ) a ON true
    GROUP BY COALESCE(rc.strategy, 'unassigned')
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
      SELECT DISTINCT ON (rb.event_id) rb.event_id, rb.ground_truth_cause, ld.root_cause
      FROM recovery_batches rb
      JOIN latest_diagnosis ld ON ld.event_id = rb.event_id
      ORDER BY rb.event_id, rb.id DESC
    )
    SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE root_cause = ground_truth_cause) AS correct
    FROM labeled
  `);

  const recentResult = await pool.query(`${CASE_SELECT} ORDER BY COALESCE(rc.expected_recovery_value, 0) DESC, rc.updated_at DESC LIMIT 6`);

  const row = metrics.rows[0] ?? {};
  const execution = executionMetrics.rows[0] ?? {};
  const contacts = contactMetrics.rows[0] ?? {};
  const links = linkMetrics.rows[0] ?? {};
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
    stoppedCases: asNumber(row.stopped_cases),
    waitingCases: asNumber(row.waiting_cases),
    scheduledCases: asNumber(row.scheduled_cases),
    escalatedCases: asNumber(row.escalated_cases),
    activePromises: asNumber(row.active_promises),
    successfulActions: asNumber(execution.successful_actions),
    contactsSent: asNumber(contacts.contacts),
    paymentLinksCreated: asNumber(execution.payment_links_created),
    trackedPaymentLinks: asNumber(links.tracked_links),
    activePaymentLinks: asNumber(links.active_links),
    paidPaymentLinks: asNumber(links.paid_links),
    inactivePaymentLinks: asNumber(links.inactive_links),
    diagnosisAccuracy: labeledTotal > 0 ? (labeledCorrect / labeledTotal) * 100 : null,
    diagnosisCorrect: labeledCorrect,
    diagnosisTotal: labeledTotal,
    states: statusResult.rows.map((item) => ({
      financialStatus: String(item.financial_status),
      automationStatus: String(item.automation_status),
      count: asNumber(item.count),
    })),
    strategies: strategyResult.rows.map((item) => ({
      strategy: String(item.strategy),
      cases: asNumber(item.cases),
      recoveredCases: asNumber(item.recovered_cases),
      recoveryRate: asNumber(item.cases) > 0 ? (asNumber(item.recovered_cases) / asNumber(item.cases)) * 100 : 0,
      recoveredAmount: asNumber(item.recovered_amount),
      averageAttempts: Number(item.average_attempts ?? 0),
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
    WHERE ($1::text IS NULL OR rc.status = $1 OR rc.financial_status = $1 OR rc.automation_status = $1)
      AND ($2::text IS NULL OR rc.customer_email ILIKE '%' || $2 || '%' OR rc.original_event_id ILIKE '%' || $2 || '%' OR COALESCE(rc.original_payment_id, '') ILIKE '%' || $2 || '%')
  `;
  const [rowsResult, countResult] = await Promise.all([
    pool.query(`${CASE_SELECT} ${where} ORDER BY COALESCE(rc.expected_recovery_value, 0) DESC, rc.updated_at DESC LIMIT $3 OFFSET $4`, [status, search, limit, offset]),
    pool.query(`SELECT COUNT(*) FROM recovery_cases rc ${where}`, [status, search]),
  ]);
  return { total: asNumber(countResult.rows[0]?.count), limit, offset, cases: rowsResult.rows.map(normalizeCaseRow) };
}

export async function getRecoveryCase(pool: Pool, caseId: number) {
  const result = await pool.query(`${CASE_SELECT} WHERE rc.id = $1 LIMIT 1`, [caseId]);
  return result.rows.length === 0 ? null : normalizeCaseRow(result.rows[0]);
}

export async function listRecoveryPaymentLinks(pool: Pool, caseId: number) {
  const result = await pool.query(
    `SELECT id, case_id, payment_link_id, action_id, short_url, status, provider_status,
            amount, amount_paid, paid_at, cancelled_at, created_at, updated_at
     FROM recovery_payment_links
     WHERE case_id = $1
     ORDER BY created_at DESC, id DESC`,
    [caseId]
  );
  return {
    caseId,
    items: result.rows.map((row) => ({
      id: asNumber(row.id),
      paymentLinkId: String(row.payment_link_id),
      actionId: row.action_id == null ? null : asNumber(row.action_id),
      shortUrl: row.short_url == null ? null : String(row.short_url),
      status: String(row.status),
      providerStatus: row.provider_status == null ? null : String(row.provider_status),
      amount: row.amount == null ? null : asNumber(row.amount),
      amountPaid: asNumber(row.amount_paid),
      paidAt: row.paid_at ?? null,
      cancelledAt: row.cancelled_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      current: String(row.status) === 'ACTIVE',
    })),
  };
}

export async function getRecoveryCaseTimeline(pool: Pool, caseId: number) {
  const caseResult = await pool.query("SELECT original_event_id FROM recovery_cases WHERE id = $1", [caseId]);
  if (caseResult.rows.length === 0) return null;
  const eventId = String(caseResult.rows[0].original_event_id);
  const result = await pool.query(`SELECT id, stage, detail, created_at FROM audit_log WHERE event_id = $1 ORDER BY created_at ASC, id ASC`, [eventId]);
  return { caseId, eventId, events: result.rows.map((row) => ({ id: asNumber(row.id), stage: String(row.stage), detail: row.detail, createdAt: row.created_at })) };
}

export async function listHumanEscalations(pool: Pool, limit = 100) {
  const boundedLimit = Math.min(200, Math.max(1, limit));
  const result = await pool.query(
    `SELECT he.id, he.case_id, he.reason, he.status, he.created_at, he.updated_at, he.resolved_at,
            rc.customer_email, rc.amount_at_risk, rc.expected_recovery_value, rc.strategy,
            rc.status AS recovery_status, rc.financial_status, rc.automation_status,
            d.root_cause, d.confidence
     FROM human_escalations he
     JOIN recovery_cases rc ON rc.id = he.case_id
     LEFT JOIN LATERAL (
       SELECT root_cause, confidence FROM diagnoses WHERE event_id = rc.original_event_id ORDER BY id DESC LIMIT 1
     ) d ON true
     ORDER BY CASE he.status WHEN 'OPEN' THEN 0 ELSE 1 END, COALESCE(rc.expected_recovery_value, 0) DESC, he.updated_at DESC
     LIMIT $1`,
    [boundedLimit]
  );
  return { items: result.rows.map((row) => ({
    id: asNumber(row.id), caseId: asNumber(row.case_id),
    customerEmail: row.customer_email == null ? null : String(row.customer_email),
    amountAtRisk: asNumber(row.amount_at_risk), expectedRecoveryValue: row.expected_recovery_value == null ? null : asNumber(row.expected_recovery_value),
    strategy: row.strategy == null ? null : String(row.strategy), recoveryStatus: String(row.recovery_status),
    financialStatus: String(row.financial_status), automationStatus: String(row.automation_status),
    reason: String(row.reason), status: String(row.status), rootCause: row.root_cause == null ? null : String(row.root_cause),
    confidence: row.confidence == null ? null : Number(row.confidence), createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at ?? null,
  })) };
}
