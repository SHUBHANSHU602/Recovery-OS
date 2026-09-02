import "dotenv/config";
import crypto from "crypto";
import express, { Request, Response } from "express";
import { Pool } from "pg";
import { ensureRecoveryCase, ensureTrack3Schema, markRecoveryFromPaymentLink } from "../recovery/recoveryStore";
import { processPendingRecoveryJobs } from "../recovery/processRecoveryCase";
import { logAuditEvent } from "../ledger/auditLog";

const app = express();
const pool = new Pool();

function validRazorpaySignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const suppliedBuffer = Buffer.from(signature, "utf8");
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

// Raw body is mandatory for Razorpay HMAC verification. Keep this route before generic JSON parsing.
app.post(
  "/webhooks/razorpay",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;
    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    const eventId = req.headers["x-razorpay-event-id"] as string | undefined;

    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      res.status(500).send("Webhook secret is not configured");
      return;
    }
    if (!validRazorpaySignature(rawBody, signature)) {
      res.status(401).send("Invalid webhook signature");
      return;
    }
    if (!eventId) {
      res.status(400).send("Missing event id");
      return;
    }

    let body: any;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).send("Malformed JSON");
      return;
    }

    const eventType = body?.event;
    if (typeof eventType !== "string") {
      res.status(400).send("Missing event type");
      return;
    }

    try {
      await ensureTrack3Schema(pool);
      const inserted = await pool.query(
        `INSERT INTO events (event_id, event_type, payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [eventId, eventType, body]
      );

      if (inserted.rows.length === 0) {
        res.status(200).send("Already processed");
        return;
      }

      if (eventType === "payment.failed") {
        await ensureRecoveryCase(pool, eventId);
        await logAuditEvent(eventId, "trusted_webhook_ingested", { eventType });
        // Durable intent lives in recovery_jobs. Kick the worker, but do not hold the webhook open for LLM/API work.
        setImmediate(() => {
          processPendingRecoveryJobs().catch((error) => console.error("Recovery worker failed:", error));
        });
      } else if (eventType === "payment_link.paid") {
        const paymentLink = body?.payload?.payment_link?.entity;
        if (!paymentLink?.id) {
          res.status(400).send("Malformed payment_link.paid payload");
          return;
        }
        const paidAmount = Number(paymentLink.amount_paid ?? paymentLink.amount ?? 0);
        const transitioned = await markRecoveryFromPaymentLink(pool, String(paymentLink.id), paidAmount);
        console.log(`Recovery outcome ${paymentLink.id}: ${transitioned ? "RECOVERED" : "no matching open case"}`);
      }

      res.status(200).send("OK");
    } catch (error: any) {
      console.error("Webhook processing error:", error.message);
      res.status(500).send("Internal error");
    }
  }
);

app.use(express.json());

app.listen(3000, () => {
  console.log("Server listening on http://localhost:3000");
  processPendingRecoveryJobs().catch((error) => console.error("Recovery worker startup failed:", error));
});
