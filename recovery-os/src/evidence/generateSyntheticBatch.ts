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
  offsetMinutes: number;
}

const templates: SyntheticEvent[] = [
  // Isolated insufficient_funds -- spread across days
  { cause: "insufficient_funds", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Insufficient balance in account", customerEmail: "customer1@example.com", bank: "HDFC", offsetMinutes: 60 * 24 * 3 },
  { cause: "insufficient_funds", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Insufficient balance in account", customerEmail: "customer2@example.com", bank: "ICICI", offsetMinutes: 60 * 24 * 2 },
  { cause: "insufficient_funds", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Insufficient balance in account", customerEmail: "customer11@example.com", bank: "SBI", offsetMinutes: 60 * 24 * 5 },
  { cause: "insufficient_funds", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Insufficient balance in account", customerEmail: "customer12@example.com", bank: "KOTAK", offsetMinutes: 60 * 10 },

  // Isolated expired_card
  { cause: "expired_card", errorCode: "GATEWAY_ERROR", errorDescription: "Card has expired", customerEmail: "customer3@example.com", bank: "HDFC", offsetMinutes: 60 * 5 },
  { cause: "expired_card", errorCode: "GATEWAY_ERROR", errorDescription: "Card has expired", customerEmail: "customer4@example.com", bank: "SBI", offsetMinutes: 60 * 8 },
  { cause: "expired_card", errorCode: "GATEWAY_ERROR", errorDescription: "Card has expired", customerEmail: "customer13@example.com", bank: "ICICI", offsetMinutes: 60 * 30 },
  { cause: "expired_card", errorCode: "GATEWAY_ERROR", errorDescription: "Card has expired", customerEmail: "customer14@example.com", bank: "AXIS", offsetMinutes: 60 * 45 },

  // Systemic outage cluster #1: AXIS, ~8 min spread
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer5@example.com", bank: "AXIS", offsetMinutes: 30 },
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer6@example.com", bank: "AXIS", offsetMinutes: 28 },
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer7@example.com", bank: "AXIS", offsetMinutes: 25 },
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer8@example.com", bank: "AXIS", offsetMinutes: 22 },

  // Systemic outage cluster #2: KOTAK, different time window entirely -- tests the correlation logic
  // catches a SECOND, independent cluster, not just the one it happened to be built around
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer15@example.com", bank: "KOTAK", offsetMinutes: 120 },
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer16@example.com", bank: "KOTAK", offsetMinutes: 118 },
  { cause: "systemic_bank_outage", errorCode: "GATEWAY_ERROR", errorDescription: "Payment authorization timed out", customerEmail: "customer17@example.com", bank: "KOTAK", offsetMinutes: 115 },

  // Ambiguous -- deliberately hard, isolated in time
  { cause: "ambiguous", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Payment declined by issuer", customerEmail: "customer9@example.com", bank: "ICICI", offsetMinutes: 60 * 30 },
  { cause: "ambiguous", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Payment declined by issuer", customerEmail: "customer10@example.com", bank: "HDFC", offsetMinutes: 60 * 50 },
  { cause: "ambiguous", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Payment declined by issuer", customerEmail: "customer18@example.com", bank: "SBI", offsetMinutes: 60 * 15 },
  { cause: "ambiguous", errorCode: "GATEWAY_ERROR", errorDescription: "Transaction could not be processed", customerEmail: "customer19@example.com", bank: "KOTAK", offsetMinutes: 60 * 60 },

  // Repeat-customer case: same customer failing twice, days apart -- exercises customerFailureCount
  { cause: "insufficient_funds", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Insufficient balance in account", customerEmail: "customer20@example.com", bank: "HDFC", offsetMinutes: 60 * 24 * 4 },
  { cause: "insufficient_funds", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Insufficient balance in account", customerEmail: "customer20@example.com", bank: "HDFC", offsetMinutes: 60 * 24 * 1 },
  { cause: "expired_card", errorCode: "GATEWAY_ERROR", errorDescription: "Card has expired", customerEmail: "customer20@example.com", bank: "HDFC", offsetMinutes: 60 * 3 },

  // A couple more isolated cases for volume
  { cause: "expired_card", errorCode: "GATEWAY_ERROR", errorDescription: "Card has expired", customerEmail: "customer21@example.com", bank: "ICICI", offsetMinutes: 60 * 70 },
  { cause: "insufficient_funds", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Insufficient balance in account", customerEmail: "customer22@example.com", bank: "AXIS", offsetMinutes: 60 * 24 * 6 },
  { cause: "ambiguous", errorCode: "BAD_REQUEST_ERROR", errorDescription: "Payment declined by issuer", customerEmail: "customer23@example.com", bank: "HDFC", offsetMinutes: 60 * 90 },
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