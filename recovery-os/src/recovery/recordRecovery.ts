import "dotenv/config";
import { Pool } from "pg";
import { logAuditEvent } from "../ledger/auditLog";

const pool = new Pool();

interface RecoveryPayload {
  event?: string;
  payload?: {
    payment_link?: { entity?: any };
    payment?: { entity?: any };
    order?: { entity?: any };
  };
}

function extractRecoveryEventId(body: RecoveryPayload): string | null {
  return (
    body.payload?.payment_link?.entity?.notes?.recovery_event_id ??
    body.payload?.order?.entity?.notes?.recovery_event_id ??
    body.payload?.payment?.entity?.notes?.recovery_event_id ??
    null
  );
}

export async function recordRecoveryFromWebhook(
  sourceWebhookEventId: string,
  body: RecoveryPayload
): Promise<boolean> {
  const originalEventId = extractRecoveryEventId(body);
  if (!originalEventId) return false;

  const paymentLink = body.payload?.payment_link?.entity;
  const payment = body.payload?.payment?.entity;
  const order = body.payload?.order?.entity;
  const amount = payment?.amount ?? paymentLink?.amount_paid ?? order?.amount_paid;
  const currency = payment?.currency ?? paymentLink?.currency ?? order?.currency ?? "INR";

  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`Recovery webhook ${sourceWebhookEventId} does not contain a valid paid amount.`);
  }

  const inserted = await pool.query(
    `INSERT INTO recoveries
       (event_id, source_webhook_event_id, payment_link_id, payment_id, recovered_amount, currency, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id`,
    [
      originalEventId,
      sourceWebhookEventId,
      paymentLink?.id ?? null,
      payment?.id ?? null,
      amount,
      currency,
      JSON.stringify(body),
    ]
  );

  if (inserted.rows.length === 0) {
    await logAuditEvent(originalEventId, "recovery_confirmation_duplicate", {
      sourceWebhookEventId,
      eventType: body.event,
    });
    return false;
  }

  await logAuditEvent(originalEventId, "recovery_confirmed", {
    sourceWebhookEventId,
    eventType: body.event,
    recoveredAmount: amount,
    currency,
    paymentLinkId: paymentLink?.id ?? null,
    paymentId: payment?.id ?? null,
  });

  return true;
}
