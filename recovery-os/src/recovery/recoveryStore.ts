import { Pool } from "pg";

export type RecoveryStatus =
  | "DETECTED"
  | "EVIDENCE_READY"
  | "DIAGNOSED"
  | "VERIFIED"
  | "ACTION_CHOSEN"
  | "POLICY_APPROVED"
  | "POLICY_BLOCKED"
  | "SCHEDULED"
  | "EXECUTED"
  | "WAITING_FOR_OUTCOME"
  | "RECOVERED"
  | "STOPPED"
  | "ESCALATED";

export const TERMINAL_RECOVERY_STATES: RecoveryStatus[] = ["RECOVERED", "STOPPED", "ESCALATED"];

export async function ensureTrack3Schema(pool: Pool): Promise<void> {
  await pool.query(`
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

    CREATE INDEX IF NOT EXISTS scheduled_actions_due_idx
      ON scheduled_actions (run_at, status);

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
      IF to_regclass('public.audit_log') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_append_only_guard') THEN
        CREATE TRIGGER audit_log_append_only_guard
        BEFORE UPDATE OR DELETE ON audit_log
        FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
      END IF;
    END $$;
  `);
}

export async function ensureRecoveryCase(pool: Pool, eventId: string): Promise<number | null> {
  const event = await pool.query("SELECT payload FROM events WHERE event_id = $1", [eventId]);
  if (event.rows.length === 0) return null;

  const payment = event.rows[0].payload?.payload?.payment?.entity;
  if (!payment) return null;

  const result = await pool.query(
    `INSERT INTO recovery_cases
       (original_event_id, original_payment_id, customer_email, amount_at_risk, status)
     VALUES ($1, $2, $3, $4, 'DETECTED')
     ON CONFLICT (original_event_id) DO UPDATE
       SET updated_at = now()
     RETURNING id`,
    [eventId, payment.id ?? null, payment.email ?? null, Number(payment.amount ?? 0)]
  );

  await pool.query(
    `INSERT INTO recovery_jobs (case_id, status)
     VALUES ($1, 'PENDING')
     ON CONFLICT (case_id) DO NOTHING`,
    [result.rows[0].id]
  );

  return Number(result.rows[0].id);
}

export async function setRecoveryState(
  pool: Pool,
  caseId: number,
  status: RecoveryStatus,
  extra: { strategy?: string; evidenceCutoffAt?: Date; terminalReason?: string } = {}
): Promise<void> {
  await pool.query(
    `UPDATE recovery_cases
     SET status = $2,
         strategy = COALESCE($3, strategy),
         evidence_cutoff_at = COALESCE($4, evidence_cutoff_at),
         terminal_reason = COALESCE($5, terminal_reason),
         updated_at = now()
     WHERE id = $1`,
    [caseId, status, extra.strategy ?? null, extra.evidenceCutoffAt ?? null, extra.terminalReason ?? null]
  );
}

export async function markRecoveryFromPaymentLink(
  pool: Pool,
  paymentLinkId: string,
  paidAmount: number,
  referenceId?: string | null
): Promise<boolean> {
  const referenceMatch = /^recovery_case_(\d+)$/.exec(referenceId ?? "");
  const referencedCaseId = referenceMatch ? Number(referenceMatch[1]) : null;

  const result = await pool.query(
    `UPDATE recovery_cases
     SET status = 'RECOVERED',
         recovered_amount = LEAST(amount_at_risk, GREATEST(recovered_amount, $2)),
         recovered_at = COALESCE(recovered_at, now()),
         terminal_reason = 'trusted_payment_link_paid',
         razorpay_payment_link_id = COALESCE(razorpay_payment_link_id, $1),
         updated_at = now()
     WHERE (razorpay_payment_link_id = $1 OR ($3::bigint IS NOT NULL AND id = $3))
       AND status NOT IN ('RECOVERED', 'STOPPED', 'ESCALATED')
     RETURNING id`,
    [paymentLinkId, Math.max(0, paidAmount), referencedCaseId]
  );
  return result.rows.length === 1;
}

export async function markOriginalPaymentCaptured(pool: Pool, paymentId: string): Promise<string[]> {
  const result = await pool.query(
    `UPDATE recovery_cases
     SET status = 'STOPPED',
         terminal_reason = 'original_payment_captured',
         updated_at = now()
     WHERE original_payment_id = $1
       AND status NOT IN ('RECOVERED', 'STOPPED', 'ESCALATED')
     RETURNING original_event_id`,
    [paymentId]
  );
  return result.rows.map((row) => String(row.original_event_id));
}

export async function createHumanEscalation(
  pool: Pool,
  caseId: number,
  eventId: string,
  reason: string
): Promise<void> {
  await pool.query(
    `INSERT INTO human_escalations (case_id, event_id, reason, status)
     VALUES ($1, $2, $3, 'OPEN')
     ON CONFLICT (case_id) DO UPDATE
       SET reason = EXCLUDED.reason,
           status = 'OPEN',
           updated_at = now()`,
    [caseId, eventId, reason]
  );
  await setRecoveryState(pool, caseId, "ESCALATED", { terminalReason: reason });
}

export async function isRecoveryTerminal(pool: Pool, eventId: string): Promise<boolean> {
  const result = await pool.query("SELECT status FROM recovery_cases WHERE original_event_id = $1", [eventId]);
  return result.rows.length > 0 && TERMINAL_RECOVERY_STATES.includes(result.rows[0].status as RecoveryStatus);
}
