import "dotenv/config";
import { Pool } from "pg";
import { logAuditEvent } from "../ledger/auditLog";

const pool = new Pool();

interface ExecutionContext {
  eventId: string;
  interventionId: number;
  finalAction: string;
  amount: number; // in paise
}

async function createRetryPaymentLink(amount: number, idempotencyKey: string) {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");

  const response = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
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

export async function executeAction(context: ExecutionContext): Promise<void> {
  const idempotencyKey = `${context.eventId}_${context.finalAction}`;

  // Idempotency check FIRST, before calling Razorpay at all -- never call a real payment API
  // without first confirming we haven't already executed this exact intervention.
  const existing = await pool.query("SELECT id, status FROM actions WHERE idempotency_key = $1", [idempotencyKey]);
  if (existing.rows.length > 0) {
    console.log(`Skipping — action already executed for intervention ${context.interventionId} (status: ${existing.rows[0].status})`);
    await logAuditEvent(context.eventId, "execution_skipped_duplicate", { interventionId: context.interventionId, idempotencyKey });
    return;
  }

  if (context.finalAction !== "retry_with_backoff") {
    console.log(`Skipping execution for action type "${context.finalAction}" — not yet implemented (Day 7 scope: retry_with_backoff only).`);
    await logAuditEvent(context.eventId, "execution_not_implemented", { interventionId: context.interventionId, finalAction: context.finalAction });
    return;
  }

  try {
    const result = await createRetryPaymentLink(context.amount, idempotencyKey);
    const status = result.status === 200 ? "success" : "failed";

    await pool.query(
      "INSERT INTO actions (intervention_id, razorpay_api_call, idempotency_key, status, response) VALUES ($1, $2, $3, $4, $5)",
      [context.interventionId, "payment_links.create", idempotencyKey, status, JSON.stringify(result.body)]
    );

    await logAuditEvent(context.eventId, "execution", { interventionId: context.interventionId, status, razorpayStatus: result.status });

    console.log(`Executed retry for intervention ${context.interventionId}: ${status}`);
  } catch (err: any) {
    await pool.query(
      "INSERT INTO actions (intervention_id, razorpay_api_call, idempotency_key, status, response) VALUES ($1, $2, $3, $4, $5)",
      [context.interventionId, "payment_links.create", idempotencyKey, "error", JSON.stringify({ error: err.message })]
    );
    await logAuditEvent(context.eventId, "execution_error", { interventionId: context.interventionId, error: err.message });
    console.error(`Execution failed for intervention ${context.interventionId}:`, err.message);
  }
}