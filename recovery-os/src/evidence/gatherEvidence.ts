import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool();

interface EvidenceBundle {
  eventId: string;
  errorCode: string;
  errorDescription: string;
  customerEmail: string;
  bank: string;
  amount: number;
  customerFailureCount: number;
  correlatedFailuresAtSameBank: number;
}

async function gatherEvidence(eventId: string): Promise<EvidenceBundle> {
  // 1. Pull the event itself
  const eventResult = await pool.query(
    "SELECT payload FROM events WHERE event_id = $1",
    [eventId]
  );

  if (eventResult.rows.length === 0) {
    throw new Error(`No event found with id ${eventId}`);
  }

  const payment = eventResult.rows[0].payload.payload.payment.entity;
  const customerEmail: string = payment.email;
  const bank: string = payment.bank;
  const createdAt: number = payment.created_at;

  // 2. Customer's failure history (excluding this event itself)
  const historyResult = await pool.query(
    `SELECT COUNT(*) FROM events
     WHERE event_type = 'payment.failed'
       AND payload->'payload'->'payment'->'entity'->>'email' = $1
       AND event_id != $2`,
    [customerEmail, eventId]
  );
  const customerFailureCount = parseInt(historyResult.rows[0].count, 10);

  // 3. Correlated failures: same bank, within a 30-minute window of this event
  const windowSeconds = 30 * 60;
  const correlatedResult = await pool.query(
    `SELECT COUNT(*) FROM events
     WHERE event_type = 'payment.failed'
       AND payload->'payload'->'payment'->'entity'->>'bank' = $1
       AND event_id != $2
       AND ABS((payload->'payload'->'payment'->'entity'->>'created_at')::bigint - $3) < $4`,
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

// Quick manual test: gather evidence for every synthetic event in batch_1
async function testAll() {
  const batchResult = await pool.query(
    "SELECT event_id, ground_truth_cause FROM recovery_batches WHERE batch_name = 'batch_1'"
  );

  for (const row of batchResult.rows) {
    const evidence = await gatherEvidence(row.event_id);
    console.log(`\n[Ground truth: ${row.ground_truth_cause}]`);
    console.log(evidence);
  }

  await pool.end();
}

testAll().catch((err) => {
  console.error("Evidence gathering failed:", err);
  process.exit(1);
});