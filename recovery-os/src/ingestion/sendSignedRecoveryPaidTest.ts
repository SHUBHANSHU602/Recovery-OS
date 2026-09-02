import "dotenv/config";
import { createHmac, randomUUID } from "crypto";

async function main() {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new Error("RAZORPAY_WEBHOOK_SECRET is missing from .env");

  const originalEventId = process.argv[2];
  if (!originalEventId) {
    throw new Error("Usage: npx tsx src/ingestion/sendSignedRecoveryPaidTest.ts <original-failed-event-id> [amount-in-paise]");
  }

  const amount = Number(process.argv[3] ?? 25000);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Amount must be a positive integer in paise.");

  const sourceEventId = `manual_paid_${randomUUID()}`;
  const body = {
    entity: "event",
    event: "payment_link.paid",
    payload: {
      payment_link: {
        entity: {
          id: `plink_${randomUUID()}`,
          amount,
          amount_paid: amount,
          currency: "INR",
          status: "paid",
          notes: { recovery_event_id: originalEventId },
        },
      },
      payment: {
        entity: {
          id: `pay_recovery_${randomUUID()}`,
          amount,
          currency: "INR",
          status: "captured",
        },
      },
    },
  };

  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  const response = await fetch(process.env.WEBHOOK_TEST_URL ?? "http://localhost:3000/webhooks/razorpay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-event-id": sourceEventId,
      "x-razorpay-signature": signature,
    },
    body: raw,
  });

  console.log(`Webhook response: ${response.status} ${await response.text()}`);
  console.log(`Original failed event: ${originalEventId}`);
  console.log(`Expected confirmed recovery: ₹${(amount / 100).toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
