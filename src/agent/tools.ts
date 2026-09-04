import "dotenv/config";
import { Pool } from "pg";
import { requestPaymentLink } from "../execution/actionService";
import { createHumanEscalation, ensureRecoveryCase, ensureTrack3Schema } from "../recovery/recoveryStore";
import { createPromiseToPay } from "../intelligence/paymentPromises";
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
  const result = await requestPaymentLink(eventId, "retry_now", null, `${eventId}_retry_now_agent_attempt_1`);
  return {
    shortUrl: result.shortUrl ?? null,
    status: result.status,
    reason: result.reason,
  };
}

export async function recordPromiseToPay(
  eventId: string,
  dueAtIso: string,
  promisedAmount?: number | null,
  note?: string | null
): Promise<{ recorded: boolean; promiseId?: number; dueAt?: string; promisedAmount?: number; reason?: string }> {
  await ensureTrack3Schema(pool);
  const caseId = await ensureRecoveryCase(pool, eventId);
  if (!caseId) return { recorded: false, reason: "Recovery case not found" };

  try {
    const dueAt = new Date(dueAtIso);
    const promise = await createPromiseToPay(pool, {
      caseId,
      promisedAmount: promisedAmount == null ? null : Number(promisedAmount),
      dueAt,
      source: "conversational_agent",
      note: note ?? null,
    });
    return {
      recorded: true,
      promiseId: promise.id,
      dueAt: promise.dueAt.toISOString(),
      promisedAmount: promise.promisedAmount,
    };
  } catch (error: any) {
    return { recorded: false, reason: error.message };
  }
}

export async function escalateToHuman(eventId: string, reason: string): Promise<{ escalated: boolean }> {
  await ensureTrack3Schema(pool);
  const caseId = await ensureRecoveryCase(pool, eventId);
  if (caseId) await createHumanEscalation(pool, caseId, eventId, reason);
  await pool.query(
    "UPDATE conversations SET status = 'escalated', updated_at = now() WHERE event_id = $1",
    [eventId]
  );
  await logAuditEvent(eventId, "human_escalation", { reason, workItemCreated: Boolean(caseId) });
  return { escalated: true };
}
