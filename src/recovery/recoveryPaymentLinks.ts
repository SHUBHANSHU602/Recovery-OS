import { Pool } from "pg";

export type RecoveryPaymentLinkStatus = "ACTIVE" | "SUPERSEDED" | "PAID" | "CANCELLED" | "EXPIRED";

export interface RecoveryPaymentLinkRow {
  id: number;
  caseId: number;
  paymentLinkId: string;
  actionId: number | null;
  shortUrl: string | null;
  status: RecoveryPaymentLinkStatus;
  providerStatus: string | null;
  amount: number | null;
  amountPaid: number;
}

export async function ensureRecoveryPaymentLinkSchema(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE recovery_cases
      ADD COLUMN IF NOT EXISTS financial_status TEXT NOT NULL DEFAULT 'OPEN'
        CHECK (financial_status IN ('OPEN', 'RECOVERED', 'STOPPED')),
      ADD COLUMN IF NOT EXISTS automation_status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (automation_status IN ('ACTIVE', 'WAITING', 'SCHEDULED', 'ESCALATED', 'EXHAUSTED', 'STOPPED'));

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
      ON recovery_payment_links(case_id) WHERE status = 'ACTIVE';
  `);
}

function mapLink(row: any): RecoveryPaymentLinkRow {
  return {
    id: Number(row.id),
    caseId: Number(row.case_id),
    paymentLinkId: String(row.payment_link_id),
    actionId: row.action_id == null ? null : Number(row.action_id),
    shortUrl: row.short_url == null ? null : String(row.short_url),
    status: row.status as RecoveryPaymentLinkStatus,
    providerStatus: row.provider_status == null ? null : String(row.provider_status),
    amount: row.amount == null ? null : Number(row.amount),
    amountPaid: Number(row.amount_paid ?? 0),
  };
}

export async function getActiveRecoveryPaymentLink(pool: Pool, caseId: number): Promise<RecoveryPaymentLinkRow | null> {
  await ensureRecoveryPaymentLinkSchema(pool);
  const result = await pool.query(
    `SELECT * FROM recovery_payment_links
     WHERE case_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [caseId]
  );
  return result.rows[0] ? mapLink(result.rows[0]) : null;
}

export async function registerRecoveryPaymentLink(
  pool: Pool,
  input: {
    caseId: number;
    paymentLinkId: string;
    actionId: number | null;
    shortUrl?: string | null;
    providerStatus?: string | null;
    amount?: number | null;
    amountPaid?: number;
  }
): Promise<RecoveryPaymentLinkRow> {
  await ensureRecoveryPaymentLinkSchema(pool);
  const result = await pool.query(
    `INSERT INTO recovery_payment_links
       (case_id, payment_link_id, action_id, short_url, status, provider_status, amount, amount_paid)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7)
     ON CONFLICT (payment_link_id) DO UPDATE
       SET action_id = COALESCE(recovery_payment_links.action_id, EXCLUDED.action_id),
           short_url = COALESCE(recovery_payment_links.short_url, EXCLUDED.short_url),
           provider_status = COALESCE(EXCLUDED.provider_status, recovery_payment_links.provider_status),
           amount = COALESCE(EXCLUDED.amount, recovery_payment_links.amount),
           amount_paid = GREATEST(recovery_payment_links.amount_paid, EXCLUDED.amount_paid),
           updated_at = now()
     RETURNING *`,
    [input.caseId, input.paymentLinkId, input.actionId, input.shortUrl ?? null, input.providerStatus ?? null, input.amount ?? null, input.amountPaid ?? 0]
  );
  return mapLink(result.rows[0]);
}

export async function updateRecoveryPaymentLinkProviderState(
  pool: Pool,
  paymentLinkId: string,
  providerStatus: string,
  amountPaid = 0
): Promise<void> {
  await ensureRecoveryPaymentLinkSchema(pool);
  const localStatus: RecoveryPaymentLinkStatus | null = providerStatus === "paid" ? "PAID" : providerStatus === "cancelled" ? "CANCELLED" : providerStatus === "expired" ? "EXPIRED" : null;
  await pool.query(
    `UPDATE recovery_payment_links
     SET provider_status = $2,
         amount_paid = GREATEST(amount_paid, $3),
         status = COALESCE($4, status),
         paid_at = CASE WHEN $4 = 'PAID' THEN COALESCE(paid_at, now()) ELSE paid_at END,
         cancelled_at = CASE WHEN $4 = 'CANCELLED' THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END,
         updated_at = now()
     WHERE payment_link_id = $1`,
    [paymentLinkId, providerStatus, Math.max(0, amountPaid), localStatus]
  );
}

export async function markRecoveryFromAnyPaymentLink(
  pool: Pool,
  paymentLinkId: string,
  paidAmount: number,
  referenceId?: string | null
): Promise<{ transitioned: boolean; caseId: number | null; originalEventId: string | null }> {
  await ensureRecoveryPaymentLinkSchema(pool);
  const referenceMatch = /^recovery_case_(\d+)$/.exec(referenceId ?? "");
  const referencedCaseId = referenceMatch ? Number(referenceMatch[1]) : null;

  const resolved = await pool.query(
    `SELECT rc.id, rc.original_event_id, rc.financial_status
     FROM recovery_cases rc
     LEFT JOIN recovery_payment_links rpl ON rpl.case_id = rc.id AND rpl.payment_link_id = $1
     WHERE rpl.payment_link_id = $1
        OR rc.razorpay_payment_link_id = $1
        OR ($2::bigint IS NOT NULL AND rc.id = $2)
     ORDER BY CASE WHEN rpl.payment_link_id = $1 THEN 0 WHEN rc.razorpay_payment_link_id = $1 THEN 1 ELSE 2 END
     LIMIT 1`,
    [paymentLinkId, referencedCaseId]
  );
  if (resolved.rows.length === 0) return { transitioned: false, caseId: null, originalEventId: null };

  const caseId = Number(resolved.rows[0].id);
  const originalEventId = String(resolved.rows[0].original_event_id);

  await pool.query(
    `INSERT INTO recovery_payment_links (case_id, payment_link_id, status, provider_status, amount_paid, paid_at)
     VALUES ($1, $2, 'PAID', 'paid', $3, now())
     ON CONFLICT (payment_link_id) DO UPDATE
       SET status = 'PAID', provider_status = 'paid',
           amount_paid = GREATEST(recovery_payment_links.amount_paid, EXCLUDED.amount_paid),
           paid_at = COALESCE(recovery_payment_links.paid_at, now()), updated_at = now()`,
    [caseId, paymentLinkId, Math.max(0, paidAmount)]
  );

  const result = await pool.query(
    `UPDATE recovery_cases
     SET status = 'RECOVERED', financial_status = 'RECOVERED', automation_status = 'STOPPED',
         recovered_amount = LEAST(amount_at_risk, GREATEST(recovered_amount, $2)),
         recovered_at = COALESCE(recovered_at, now()), terminal_reason = 'trusted_payment_link_paid',
         razorpay_payment_link_id = $1, updated_at = now()
     WHERE id = $3 AND financial_status = 'OPEN'
     RETURNING id`,
    [paymentLinkId, Math.max(0, paidAmount), caseId]
  );

  if (result.rows.length === 1) {
    await pool.query(`UPDATE recovery_payment_links SET status = 'SUPERSEDED', updated_at = now() WHERE case_id = $1 AND payment_link_id <> $2 AND status = 'ACTIVE'`, [caseId, paymentLinkId]);
    await pool.query(`UPDATE payment_promises SET status = 'FULFILLED', fulfilled_at = COALESCE(fulfilled_at, now()), updated_at = now() WHERE case_id = $1 AND status = 'PENDING'`, [caseId]);
    await pool.query(`UPDATE scheduled_actions SET status = 'CANCELLED', updated_at = now() WHERE case_id = $1 AND status = 'PENDING'`, [caseId]);
    await pool.query(`UPDATE human_escalations SET status = 'RESOLVED', resolved_at = COALESCE(resolved_at, now()), updated_at = now() WHERE case_id = $1 AND status = 'OPEN'`, [caseId]);
  }
  return { transitioned: result.rows.length === 1, caseId, originalEventId };
}

export async function markOriginalPaymentCapturedFinancial(
  pool: Pool,
  paymentId: string
): Promise<Array<{ caseId: number; originalEventId: string }>> {
  await ensureRecoveryPaymentLinkSchema(pool);
  const result = await pool.query(
    `UPDATE recovery_cases
     SET status = 'STOPPED', financial_status = 'STOPPED', automation_status = 'STOPPED',
         terminal_reason = 'original_payment_captured', updated_at = now()
     WHERE original_payment_id = $1 AND financial_status = 'OPEN' AND status <> 'RECOVERED'
     RETURNING id, original_event_id`,
    [paymentId]
  );
  for (const row of result.rows) {
    const caseId = Number(row.id);
    await pool.query(`UPDATE recovery_payment_links SET status = 'SUPERSEDED', updated_at = now() WHERE case_id = $1 AND status = 'ACTIVE'`, [caseId]);
    await pool.query(`UPDATE payment_promises SET status = 'CANCELLED', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now() WHERE case_id = $1 AND status = 'PENDING'`, [caseId]);
    await pool.query(`UPDATE scheduled_actions SET status = 'CANCELLED', updated_at = now() WHERE case_id = $1 AND status = 'PENDING'`, [caseId]);
    await pool.query(`UPDATE human_escalations SET status = 'RESOLVED', resolved_at = COALESCE(resolved_at, now()), updated_at = now() WHERE case_id = $1 AND status = 'OPEN'`, [caseId]);
  }
  return result.rows.map((row) => ({ caseId: Number(row.id), originalEventId: String(row.original_event_id) }));
}
