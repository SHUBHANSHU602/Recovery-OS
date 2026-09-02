import "dotenv/config";
import { Pool } from "pg";
import { logAuditEvent } from "../ledger/auditLog";
import { startConversation } from "../agent/conversationalAgent";

const pool = new Pool();

interface ExecutionContext {
  eventId: string;
  interventionId: number;
  finalAction: string;
  amount: number;
  customerEmail: string;
}

async function createRetryPaymentLink(amount: number, idempotencyKey: string) {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      amount,
      currency: "INR",
      description: `Recovery OS retry — ${idempotencyKey}`,
      notify: { sms: false, email: false },
    }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

const OPENING_MESSAGES: Record<string, string> = {
  whatsapp_nudge: "Hi! We noticed your recent payment didn't go through — it looked like an insufficient balance issue. Would you like a fresh payment link to try again?",
  offer_alternate_payment_method: "Hi! Your card on file appears to have expired, so the payment couldn't go through. Would you like to pay using a different method?",
};

export async function executeAction(context: ExecutionContext): Promise<void> {
  const idempotencyKey = `${context.eventId}_${context.finalAction}`;

  const existing = await pool.query("SELECT id, status FROM actions WHERE idempotency_key = $1", [idempotencyKey]);
  if (existing.rows.length > 0) {
    console.log(`Skipping — action already executed for event ${context.eventId} (${context.finalAction}, status: ${existing.rows[0].status})`);
    await logAuditEvent(context.eventId, "execution_skipped_duplicate", { interventionId: context.interventionId, idempotencyKey });
    return;
  }

  if (context.finalAction === "retry_with_backoff") {
    try {
      const result = await createRetryPaymentLink(context.amount, idempotencyKey);
      const status = result.status === 200 ? "success" : "failed";
      await pool.query(
        "INSERT INTO actions (intervention_id, razorpay_api_call, idempotency_key, status, response) VALUES ($1, $2, $3, $4, $5)",
        [context.interventionId, "payment_links.create", idempotencyKey, status, JSON.stringify(result.body)]
      );
      await logAuditEvent(context.eventId, "execution", { interventionId: context.interventionId, status, razorpayStatus: result.status });
      console.log(`Executed retry for event ${context.eventId}: ${status}`);
    } catch (err: any) {
      await pool.query(
        "INSERT INTO actions (intervention_id, razorpay_api_call, idempotency_key, status, response) VALUES ($1, $2, $3, $4, $5)",
        [context.interventionId, "payment_links.create", idempotencyKey, "error", JSON.stringify({ error: err.message })]
      );
      await logAuditEvent(context.eventId, "execution_error", { interventionId: context.interventionId, error: err.message });
      console.error(`Execution failed for event ${context.eventId}:`, err.message);
    }
    return;
  }

  if (context.finalAction === "whatsapp_nudge" || context.finalAction === "offer_alternate_payment_method") {
    try {
      const opening = OPENING_MESSAGES[context.finalAction];
      const agentReply = await startConversation(context.eventId, context.customerEmail, context.amount, opening);

      await pool.query(
        "INSERT INTO actions (intervention_id, razorpay_api_call, idempotency_key, status, response) VALUES ($1, $2, $3, $4, $5)",
        [context.interventionId, "conversational_agent.start", idempotencyKey, "success", JSON.stringify({ openingMessage: opening, agentReply })]
      );
      await logAuditEvent(context.eventId, "execution_conversation_started", { interventionId: context.interventionId, finalAction: context.finalAction, agentReply });
      console.log(`Started conversation for event ${context.eventId} (${context.finalAction})`);
    } catch (err: any) {
      await pool.query(
        "INSERT INTO actions (intervention_id, razorpay_api_call, idempotency_key, status, response) VALUES ($1, $2, $3, $4, $5)",
        [context.interventionId, "conversational_agent.start", idempotencyKey, "error", JSON.stringify({ error: err.message })]
      );
      await logAuditEvent(context.eventId, "execution_error", { interventionId: context.interventionId, error: err.message });
      console.error(`Conversation start failed for event ${context.eventId}:`, err.message);
    }
    return;
  }

  // escalate_to_human and anything else: log and stop, no automated action
  console.log(`No automated execution for action "${context.finalAction}" — requires human handling.`);
  await logAuditEvent(context.eventId, "execution_requires_human", { interventionId: context.interventionId, finalAction: context.finalAction });
}