import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool();

export interface EvidenceBundle {
  eventId: string;
  errorCode: string;
  errorDescription: string;
  customerEmail: string;
  bank: string;
  amount: number;
  customerFailureCount: number;
  correlatedFailuresAtSameBank: number;
}

export async function gatherEvidence(eventId: string): Promise<EvidenceBundle> {
  const eventResult = await pool.query("SELECT payload FROM events WHERE event_id = $1", [eventId]);
  if (eventResult.rows.length === 0) throw new Error(`No event found with id ${eventId}`);

  const payment = eventResult.rows[0].payload.payload.payment.entity;
  const customerEmail: string = payment.email;
  const bank: string = payment.bank;
  const createdAt: number = payment.created_at;

  const historyResult = await pool.query(
    `SELECT COUNT(*) FROM events
     WHERE event_type = 'payment.failed'
       AND payload->'payload'->'payment'->'entity'->>'email' = $1
       AND (payload->'payload'->'payment'->'entity'->>'created_at')::bigint < $2`,
    [customerEmail, createdAt]
  );
  const customerFailureCount = parseInt(historyResult.rows[0].count, 10);

  const windowSeconds = 30 * 60;
  const correlatedResult = await pool.query(
    `SELECT COUNT(*) FROM events
     WHERE event_type = 'payment.failed'
       AND payload->'payload'->'payment'->'entity'->>'bank' = $1
       AND event_id != $2
       AND (payload->'payload'->'payment'->'entity'->>'created_at')::bigint < $3
       AND (payload->'payload'->'payment'->'entity'->>'created_at')::bigint >= $3 - $4`,
    [bank, eventId, createdAt, windowSeconds]
  );
  const correlatedFailuresAtSameBank = parseInt(correlatedResult.rows[0].count, 10);

  return {
    eventId,
    errorCode: payment.error_code,
    errorDescription: payment.error_description,
    customerEmail,
    bank,
    amount: payment.amount,
    customerFailureCount,
    correlatedFailuresAtSameBank,
  };
}
