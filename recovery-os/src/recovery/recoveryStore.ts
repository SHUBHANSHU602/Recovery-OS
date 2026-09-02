import { Pool } from "pg";

export type RecoveryStatus =
  | "DETECTED"
  | "EVIDENCE_READY"
  | "DIAGNOSED"
  | "VERIFIED"
  | "ACTION_CHOSEN"
  | "POLICY_APPROVED"
  | "POLICY_BLOCKED"
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
  paidAmount: number
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE recovery_cases
     SET status = 'RECOVERED',
         recovered_amount = LEAST(amount_at_risk, GREATEST(recovered_amount, $2)),
         recovered_at = COALESCE(recovered_at, now()),
         terminal_reason = 'trusted_payment_link_paid',
         updated_at = now()
     WHERE razorpay_payment_link_id = $1
       AND status <> 'RECOVERED'
     RETURNING id`,
    [paymentLinkId, Math.max(0, paidAmount)]
  );
  return result.rows.length === 1;
}

export async function isRecoveryTerminal(pool: Pool, eventId: string): Promise<boolean> {
  const result = await pool.query("SELECT status FROM recovery_cases WHERE original_event_id = $1", [eventId]);
  return result.rows.length > 0 && TERMINAL_RECOVERY_STATES.includes(result.rows[0].status as RecoveryStatus);
}
