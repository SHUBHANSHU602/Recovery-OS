import "dotenv/config";
import { Pool } from "pg";
import { logAuditEvent } from "../ledger/auditLog";
import { startConversation } from "../agent/conversationalAgent";
import { executeRecoveryPaymentLink } from "./paymentLinkExecutor";
import { scheduleRecoveryPaymentLink } from "./scheduler";

const pool = new Pool();

interface ExecutionContext {
  eventId: string;
  interventionId: number;
  finalAction: string;
  amount: number;
  customerEmail: string;
}

const OPENING_MESSAGES: Record<string, string> = {
  whatsapp_nudge: "Hi! We noticed your recent payment did not go through. Would you like help completing it?",
  offer_alternate_payment_method: "Hi! Your earlier payment method could not complete the payment. I can help you retry with another method.",
};

async function claimConversationStart(context: ExecutionContext): Promise<boolean> {
  const idempotencyKey = `${context.eventId}_${context.finalAction}`;
  const result = await pool.query(
    `INSERT INTO actions
       (event_id, intervention_id, razorpay_api_call, idempotency_key, status, response)
     VALUES ($1, $2, 'conversation.start', $3, 'success', '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [context.eventId, context.interventionId, idempotencyKey]
  );
  return result.rows.length > 0;
}

export async function executeAction(context: ExecutionContext): Promise<void> {
  if (context.finalAction === "stop_recovery") {
    await logAuditEvent(context.eventId, "execution_stopped", { interventionId: context.interventionId, reason: "Payment already recovered." });
    return;
  }

  if (context.finalAction === "retry_now") {
    await executeRecoveryPaymentLink({
      eventId: context.eventId,
      interventionId: context.interventionId,
      amount: context.amount,
      customerEmail: context.customerEmail,
      actionType: "retry_now",
    });
    return;
  }

  if (context.finalAction === "retry_with_backoff") {
    const delaySeconds = Number(process.env.RECOVERY_BACKOFF_SECONDS ?? 300);
    await scheduleRecoveryPaymentLink(context.eventId, context.interventionId, delaySeconds);
    return;
  }

  if (context.finalAction === "whatsapp_nudge" || context.finalAction === "offer_alternate_payment_method") {
    const claimed = await claimConversationStart(context);
    if (!claimed) {
      await logAuditEvent(context.eventId, "execution_skipped_duplicate", { actionType: context.finalAction });
      return;
    }

    const opening = OPENING_MESSAGES[context.finalAction];
    await startConversation(context.eventId, context.customerEmail, context.amount, opening);
    await logAuditEvent(context.eventId, "customer_contact_started", {
      interventionId: context.interventionId,
      channel: context.finalAction === "whatsapp_nudge" ? "whatsapp_simulation" : "recovery_conversation",
      openingMessage: opening,
    });
    return;
  }

  await logAuditEvent(context.eventId, "execution_requires_human", { interventionId: context.interventionId, finalAction: context.finalAction });
}
