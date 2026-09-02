import "dotenv/config";
import { Pool } from "pg";
import { logAuditEvent } from "../ledger/auditLog";

const pool = new Pool();

interface PaymentLinkInput {
  eventId: string;
  interventionId: number | null;
  amount: number;
  customerEmail: string;
  actionType: string;
}

export interface PaymentLinkExecutionResult {
  status: "success" | "failed" | "error" | "already_executed";
  shortUrl: string | null;
  razorpayStatus?: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callRazorpayWithBackoff(input: PaymentLinkInput) {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error("RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing from .env");
  }

  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: input.amount,
        currency: "INR",
        description: `Recovery OS payment recovery for ${input.eventId}`,
        customer: { email: input.customerEmail },
        notify: { sms: false, email: false },
        notes: { recovery_event_id: input.eventId, recovery_action: input.actionType },
      }),
    });

    const body = await response.json();
    if (response.status !== 429 || attempt === maxAttempts) {
      return { response, body };
    }

    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000 * 2 ** (attempt - 1);
    await sleep(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 1000 * 2 ** (attempt - 1));
  }

  throw new Error("Unreachable Razorpay retry loop state.");
}

export async function executeRecoveryPaymentLink(input: PaymentLinkInput): Promise<PaymentLinkExecutionResult> {
  const idempotencyKey = `${input.eventId}_${input.actionType}`;

  const claim = await pool.query(
    `INSERT INTO actions
       (event_id, intervention_id, razorpay_api_call, idempotency_key, status, response)
     VALUES ($1, $2, 'payment_links.create', $3, 'pending', '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [input.eventId, input.interventionId, idempotencyKey]
  );

  if (claim.rows.length === 0) {
    const existing = await pool.query(
      "SELECT status, response FROM actions WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    const response = existing.rows[0]?.response ?? {};
    await logAuditEvent(input.eventId, "execution_skipped_duplicate", { idempotencyKey });
    return {
      status: "already_executed",
      shortUrl: response.short_url ?? null,
    };
  }

  const actionId = claim.rows[0].id as number;

  try {
    const { response, body } = await callRazorpayWithBackoff(input);
    const status = response.ok ? "success" : "failed";

    await pool.query(
      "UPDATE actions SET status = $1, response = $2 WHERE id = $3",
      [status, JSON.stringify(body), actionId]
    );

    await logAuditEvent(input.eventId, "execution_payment_link", {
      actionType: input.actionType,
      idempotencyKey,
      status,
      razorpayStatus: response.status,
      paymentLinkId: body.id ?? null,
    });

    return {
      status,
      shortUrl: body.short_url ?? null,
      razorpayStatus: response.status,
    };
  } catch (err: any) {
    await pool.query(
      "UPDATE actions SET status = 'error', response = $1 WHERE id = $2",
      [JSON.stringify({ error: err.message }), actionId]
    );
    await logAuditEvent(input.eventId, "execution_error", {
      actionType: input.actionType,
      idempotencyKey,
      error: err.message,
    });
    return { status: "error", shortUrl: null };
  }
}
