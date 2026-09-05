import type { Pool } from "pg";

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

export async function listRecentActivity(pool: Pool, limit = 40) {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const result = await pool.query(
    `SELECT
       al.id,
       al.event_id,
       al.stage,
       al.detail,
       al.created_at,
       rc.id AS case_id,
       rc.customer_email,
       rc.status AS case_status
     FROM audit_log al
     LEFT JOIN recovery_cases rc ON rc.original_event_id = al.event_id
     ORDER BY al.created_at DESC, al.id DESC
     LIMIT $1`,
    [boundedLimit]
  );

  return {
    items: result.rows.map((row) => ({
      id: asNumber(row.id),
      eventId: String(row.event_id),
      caseId: row.case_id == null ? null : asNumber(row.case_id),
      customerEmail: row.customer_email == null ? null : String(row.customer_email),
      caseStatus: row.case_status == null ? null : String(row.case_status),
      stage: String(row.stage),
      detail: row.detail,
      createdAt: row.created_at,
    })),
  };
}

export async function getCaseConversation(pool: Pool, caseId: number) {
  const result = await pool.query(
    `SELECT
       rc.id,
       rc.original_event_id,
       rc.customer_email,
       rc.amount_at_risk,
       c.status AS conversation_status,
       c.messages,
       c.updated_at AS conversation_updated_at
     FROM recovery_cases rc
     LEFT JOIN conversations c ON c.event_id = rc.original_event_id
     WHERE rc.id = $1`,
    [caseId]
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const messages = Array.isArray(row.messages) ? row.messages : [];
  return {
    caseId,
    eventId: String(row.original_event_id),
    customerEmail: row.customer_email == null ? null : String(row.customer_email),
    amountAtRisk: asNumber(row.amount_at_risk),
    status: row.conversation_status == null ? "not_started" : String(row.conversation_status),
    updatedAt: row.conversation_updated_at ?? null,
    messages: messages.map((message: any, index: number) => ({
      index,
      role: String(message?.role ?? "unknown"),
      content: typeof message?.content === "string" ? message.content : null,
      toolCalls: Array.isArray(message?.tool_calls)
        ? message.tool_calls.map((call: any) => ({
            id: call?.id == null ? null : String(call.id),
            name: call?.function?.name == null ? null : String(call.function.name),
            arguments: call?.function?.arguments == null ? null : String(call.function.arguments),
          }))
        : [],
      toolCallId: message?.tool_call_id == null ? null : String(message.tool_call_id),
    })),
  };
}

export async function getCaseRuntimeState(pool: Pool, caseId: number) {
  const caseResult = await pool.query(
    "SELECT original_event_id FROM recovery_cases WHERE id = $1",
    [caseId]
  );
  if (caseResult.rows.length === 0) return null;
  const eventId = String(caseResult.rows[0].original_event_id);

  const [actions, schedules, contacts, plans] = await Promise.all([
    pool.query(
      `SELECT DISTINCT
         a.id,
         a.razorpay_api_call,
         a.idempotency_key,
         a.status,
         a.response,
         a.created_at
       FROM actions a
       LEFT JOIN interventions i ON i.id = a.intervention_id
       LEFT JOIN diagnoses d ON d.id = i.diagnosis_id
       WHERE d.event_id = $1
          OR a.idempotency_key LIKE $1 || '%'
       ORDER BY a.id DESC
       LIMIT 25`,
      [eventId]
    ),
    pool.query(
      `SELECT id, desired_action, schedule_key, run_at, status, attempt_count, last_error, created_at, updated_at
       FROM scheduled_actions
       WHERE case_id = $1
       ORDER BY id DESC
       LIMIT 25`,
      [caseId]
    ),
    pool.query(
      `SELECT id, channel, purpose, delivery_state, sent_at
       FROM outbound_contacts
       WHERE case_id = $1
       ORDER BY id DESC
       LIMIT 25`,
      [caseId]
    ),
    pool.query(
      `SELECT version, trigger, objective, primary_action, fallback_action, reasoning,
              escalation_criteria, stop_conditions, policy_result, policy_final_action, created_at
       FROM recovery_plans
       WHERE case_id = $1
       ORDER BY version DESC`,
      [caseId]
    ),
  ]);

  return {
    caseId,
    eventId,
    actions: actions.rows.map((row) => ({
      id: asNumber(row.id),
      apiCall: String(row.razorpay_api_call),
      idempotencyKey: String(row.idempotency_key),
      status: String(row.status),
      response: row.response,
      createdAt: row.created_at,
    })),
    scheduledActions: schedules.rows.map((row) => ({
      id: asNumber(row.id),
      desiredAction: String(row.desired_action),
      scheduleKey: String(row.schedule_key),
      runAt: row.run_at,
      status: String(row.status),
      attemptCount: asNumber(row.attempt_count),
      lastError: row.last_error == null ? null : String(row.last_error),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    contacts: contacts.rows.map((row) => ({
      id: asNumber(row.id),
      channel: String(row.channel),
      purpose: String(row.purpose),
      deliveryState: String(row.delivery_state),
      sentAt: row.sent_at,
    })),
    plans: plans.rows.map((row) => ({
      version: asNumber(row.version),
      trigger: String(row.trigger),
      objective: String(row.objective),
      primaryAction: String(row.primary_action),
      fallbackAction: String(row.fallback_action),
      reasoning: String(row.reasoning),
      escalationCriteria: Array.isArray(row.escalation_criteria) ? row.escalation_criteria : [],
      stopConditions: Array.isArray(row.stop_conditions) ? row.stop_conditions : [],
      policyResult: String(row.policy_result),
      policyFinalAction: String(row.policy_final_action),
      createdAt: row.created_at,
    })),
  };
}
