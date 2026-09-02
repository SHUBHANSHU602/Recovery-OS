import "dotenv/config";
import { Pool } from "pg";
import { requestPaymentLink } from "../execution/actionService";
import { ensureRecoveryCase, ensureTrack3Schema, setRecoveryState } from "../recovery/recoveryStore";
import { logAuditEvent } from "../ledger/auditLog";

const pool = new Pool();

export async function checkCustomerRiskFlags(customerEmail: string): Promise<{ failureCount: number; flagged: boolean }> {
  const result = await pool.query(
    `SELECT COUNT(*) FROM events
     WHERE event_type = 'payment.failed'
       AND payload->'payload'->'payment'->'entity'->>'email' = $1`,
    [customerEmail]
  );
  const failureCount = parseInt(result.rows[0].count, 10);
  return { failureCount, flagged: failureCount >= 3 };
}

// The LLM requests intent only. Trusted amount/customer identity are loaded by ActionService.
export async function generatePaymentLink(eventId: string, _amount: number): Promise<{ shortUrl: string | null; status: string; reason?: string }> {
  const result = await requestPaymentLink(eventId, "retry_now", null);
  return {
    shortUrl: result.shortUrl ?? null,
    status: result.status,
    reason: result.reason,
  };
}

export async function escalateToHuman(eventId: string, reason: string): Promise<{ escalated: boolean }> {
  await ensureTrack3Schema(pool);
  const caseId = await ensureRecoveryCase(pool, eventId);
  if (caseId) await setRecoveryState(pool, caseId, "ESCALATED", { terminalReason: reason });
  await pool.query(
    "UPDATE conversations SET status = 'escalated', updated_at = now() WHERE event_id = $1",
    [eventId]
  );
  await logAuditEvent(eventId, "human_escalation", { reason });
  return { escalated: true };
}
