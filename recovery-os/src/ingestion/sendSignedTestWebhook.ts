import "dotenv/config";
import { createHmac, randomUUID } from "crypto";

async function main() {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new Error("RAZORPAY_WEBHOOK_SECRET is missing from .env");

  const eventId = `manual_test_${randomUUID()}`;
  const body = {
    entity: "event",
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: `pay_${randomUUID()}`,
          amount: 25000,
          currency: "INR",
          status: "failed",
          method: "card",
          email: "signed-webhook-test@example.com",
          bank: "HDFC",
          error_code: "BAD_REQUEST_ERROR",
          error_description: "Payment declined by issuer",
          created_at: Math.floor(Date.now() / 1000),
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
      "x-razorpay-event-id": eventId,
      "x-razorpay-signature": signature,
    },
    body: raw,
  });

  console.log(`Webhook response: ${response.status} ${await response.text()}`);
  console.log(`Event id: ${eventId}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
