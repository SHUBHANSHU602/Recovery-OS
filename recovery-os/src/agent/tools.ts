import "dotenv/config";
import { Pool } from "pg";
import { getPolicyRuntimeContext } from "../policy/policyContext";
import { applyPolicyGate } from "../policy/policyGate";
import { executeRecoveryPaymentLink } from "../execution/paymentLinkExecutor";
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

export async function generatePaymentLink(
  eventId: string,
  amount: number,
  customerEmail: string
): Promise<{ shortUrl: string | null; status: string; reason?: string }> {
  const policyContext = await getPolicyRuntimeContext(eventId);
  const policy = applyPolicyGate({
    chosenAction: "offer_alternate_payment_method",
    automatedRecoveryAttemptCount: policyContext.automatedRecoveryAttemptCount,
    customerContactedInLast24h: policyContext.customerContactedInLast24h,
    paymentAlreadyRecovered: policyContext.paymentAlreadyRecovered,
  });

  if (policy.result !== "APPROVED") {
    await logAuditEvent(eventId, "conversational_payment_link_blocked", { result: policy.result, reason: policy.reason });
    return { shortUrl: null, status: "blocked", reason: policy.reason };
  }

  const result = await executeRecoveryPaymentLink({
    eventId,
    interventionId: null,
    amount,
    customerEmail,
    actionType: "conversational_payment_link",
  });

  return { shortUrl: result.shortUrl, status: result.status };
}

export async function escalateToHuman(eventId: string, reason: string): Promise<{ escalated: boolean }> {
  await pool.query("UPDATE conversations SET status = 'escalated', updated_at = now() WHERE event_id = $1", [eventId]);
  await logAuditEvent(eventId, "human_escalation", { reason });
  return { escalated: true };
}
