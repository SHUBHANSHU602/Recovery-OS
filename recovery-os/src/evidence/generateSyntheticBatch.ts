import "dotenv/config";
import { Pool } from "pg";
import { randomUUID } from "crypto";

const pool = new Pool();

type Cause = "insufficient_funds" | "expired_card" | "systemic_bank_outage" | "ambiguous";

interface SyntheticEvent {
  cause: Cause;
  errorCode: string;
  errorDescription: string;
  customerEmail: string;
  bank: string;
  // offsetMinutes: how far back from "now" this event happened, in minutes
  offsetMinutes: number;
}

const templates: SyntheticEvent[] = [
  // Isolated events -- spread far apart (hours/days), so they never fall in each other's 30-min window
  { cause: "insufficient_funds", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Insufficient balance in account", customerEmail: "customer1@example.com", bank: "HDFC", offsetMinutes: 60 * 24 * 3 },      // 3 days ago
  { cause: "insufficient_funds", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Insufficient balance in account", customerEmail: "customer2@example.com", bank: "ICICI", offsetMinutes: 60 * 24 * 2 },     // 2 days ago
  { cause: "expired_card", errorCode: "GATEWAY_ERROR", errorDescription: "Card has expired", customerEmail: "customer3@example.com", bank: "HDFC", offsetMinutes: 60 * 5 },                                    // 5 hours ago
  { cause: "expired_card", errorCode: "GATEWAY_ERROR", errorDescription: "Card has expired", customerEmail: "customer4@example.com", bank: "SBI", offsetMinutes: 60 * 8 },                                     // 8 hours ago

  // Systemic outage: SAME bank, all within a few minutes of each other -- this is the real cluster
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer5@example.com", bank: "AXIS", offsetMinutes: 30 },
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer6@example.com", bank: "AXIS", offsetMinutes: 28 },
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer7@example.com", bank: "AXIS", offsetMinutes: 25 },
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer8@example.com", bank: "AXIS", offsetMinutes: 22 },

  // Ambiguous -- isolated in time, deliberately hard to classify from error code alone
  { cause: "ambiguous", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Payment declined by issuer", customerEmail: "customer9@example.com", bank: "ICICI", offsetMinutes: 60 * 30 },   // 30 hours ago
  { cause: "ambiguous", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Payment declined by issuer", customerEmail: "customer10@example.com", bank: "HDFC", offsetMinutes: 60 * 50 },   // 50 hours ago
];

async function generateBatch(batchName: string) {
  const now = Math.floor(Date.now() / 1000);

  for (const t of templates) {
    const eventId = `synthetic_${randomUUID()}`;
    const createdAt = now - t.offsetMinutes * 60;

    const payload = {
      entity: "event",
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: `pay_synthetic_${randomUUID()}`,
            amount: Math.floor(Math.random() * 100000) + 10000,
            currency: "INR",
            status: "failed",
            method: "card",
            email: t.customerEmail,
            bank: t.bank,
            error_code: t.errorCode,
            error_description: t.errorDescription,
            created_at: createdAt,
          },
        },
      },
    };

    await pool.query(
      "INSERT INTO events (event_id, event_type, payload) VALUES ($1, $2, $3)",
      [eventId, "payment.failed", payload]
    );

    await pool.query(
      "INSERT INTO recovery_batches (batch_name, event_id, ground_truth_cause) VALUES ($1, $2, $3)",
      [batchName, eventId, t.cause]
    );

    console.log(`Inserted synthetic event ${eventId} — ground truth: ${t.cause} — offset: ${t.offsetMinutes}min ago`);
  }

  console.log(`\nBatch "${batchName}" complete: ${templates.length} events inserted.`);
  await pool.end();
}

generateBatch("batch_1").catch((err) => {
  console.error("Batch generation failed:", err);
  process.exit(1);
});