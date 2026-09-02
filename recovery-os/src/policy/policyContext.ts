import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool();

export interface PolicyRuntimeContext {
  customerFailureCount: number;
  automatedRecoveryAttemptCount: number;
  customerContactedInLast24h: boolean;
  paymentAlreadyRecovered: boolean;
}

export async function getPolicyRuntimeContext(eventId: string): Promise<PolicyRuntimeContext> {
  const eventResult = await pool.query(
    `SELECT
       payload->'payload'->'payment'->'entity'->>'email' AS customer_email,
       (payload->'payload'->'payment'->'entity'->>'created_at')::bigint AS created_at
     FROM events
     WHERE event_id = $1`,
    [eventId]
  );

  if (eventResult.rows.length === 0) {
    throw new Error(`Cannot build policy context: event ${eventId} does not exist.`);
  }

  const customerEmail = eventResult.rows[0].customer_email as string;
  const createdAt = Number(eventResult.rows[0].created_at);

  const failureResult = await pool.query(
    `SELECT COUNT(*)
     FROM events
     WHERE event_type = 'payment.failed'
       AND payload->'payload'->'payment'->'entity'->>'email' = $1
       AND (payload->'payload'->'payment'->'entity'->>'created_at')::bigint < $2`,
    [customerEmail, createdAt]
  );

  const attemptsResult = await pool.query(
    `SELECT COUNT(*)
     FROM actions
     WHERE event_id = $1
       AND razorpay_api_call = 'payment_links.create'
       AND status IN ('pending', 'success')`,
    [eventId]
  );

  const contactResult = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM audit_log al
       JOIN events e ON e.event_id = al.event_id
       WHERE al.stage = 'customer_contact_started'
         AND al.created_at >= now() - interval '24 hours'
         AND e.payload->'payload'->'payment'->'entity'->>'email' = $1
     ) AS contacted`,
    [customerEmail]
  );

  const recoveredResult = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM recoveries WHERE event_id = $1) AS recovered`,
    [eventId]
  );

  return {
    customerFailureCount: Number(failureResult.rows[0].count),
    automatedRecoveryAttemptCount: Number(attemptsResult.rows[0].count),
    customerContactedInLast24h: Boolean(contactResult.rows[0].contacted),
    paymentAlreadyRecovered: Boolean(recoveredResult.rows[0].recovered),
  };
}
