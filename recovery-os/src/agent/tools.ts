import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool();

// Tool 1: check_customer_risk_flags -- deterministic DB lookup, no LLM
export async function checkCustomerRiskFlags(customerEmail: string): Promise<{ failureCount: number; flagged: boolean }> {
  const result = await pool.query(
    `SELECT COUNT(*) FROM events
     WHERE event_type = 'payment.failed'
       AND payload->'payload'->'payment'->'entity'->>'email' = $1`,
    [customerEmail]
  );
  const failureCount = parseInt(result.rows[0].count, 10);
  // Simple deterministic rule: 3+ prior failures is a flag worth a human's attention
  return { failureCount, flagged: failureCount >= 3 };
}

// Tool 2: generate_payment_link -- real Razorpay call, IDEMPOTENT (same principle as Day 7 execution)
export async function generatePaymentLink(eventId: string, amount: number): Promise<{ shortUrl: string | null; status: string }> {
  const idempotencyKey = `${eventId}_conversational_payment_link`;

  const existing = await pool.query("SELECT response FROM actions WHERE idempotency_key = $1", [idempotencyKey]);
  if (existing.rows.length > 0) {
    const prior = existing.rows[0].response;
    return { shortUrl: prior.short_url ?? null, status: "already_generated" };
  }

  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      amount,
      currency: "INR",
      description: `Recovery OS conversational retry — ${idempotencyKey}`,
      notify: { sms: false, email: false },
    }),
  });
  const body = await response.json();

  await pool.query(
    "INSERT INTO actions (intervention_id, razorpay_api_call, idempotency_key, status, response) VALUES ($1, $2, $3, $4, $5)",
    [null, "payment_links.create", idempotencyKey, response.status === 200 ? "success" : "failed", JSON.stringify(body)]
  );

  return { shortUrl: body.short_url ?? null, status: response.status === 200 ? "success" : "failed" };
}

// Tool 3: escalate_to_human -- deterministic, just logs the escalation
export async function escalateToHuman(eventId: string, reason: string): Promise<{ escalated: boolean }> {
  await pool.query(
    "UPDATE conversations SET status = 'escalated', updated_at = now() WHERE event_id = $1",
    [eventId]
  );
  return { escalated: true };
}