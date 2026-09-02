import "dotenv/config";
import crypto from "crypto";
import express, { Request, Response } from "express";
import { Pool } from "pg";
import {
  ensureRecoveryCase,
  ensureTrack3Schema,
  markOriginalPaymentCaptured,
  markRecoveryFromPaymentLink,
} from "../recovery/recoveryStore";
import { processPendingRecoveryJobs } from "../recovery/processRecoveryCase";
import { processDueScheduledActions } from "../execution/scheduledActions";
import { logAuditEvent } from "../ledger/auditLog";

const app = express();
const pool = new Pool();
const STALE_WEBHOOK_MINUTES = 5;
const WORKER_POLL_MS = Number(process.env.RECOVERY_WORKER_POLL_MS ?? 5000);

function validRazorpaySignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const suppliedBuffer = Buffer.from(signature, "utf8");
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

async function processWebhookDelivery(eventId: string): Promise<"processed" | "busy"> {
  const claim = await pool.query(
    `UPDATE webhook_deliveries
     SET status = 'PROCESSING',
         claimed_at = now(),
         attempt_count = attempt_count + 1,
         updated_at = now()
     WHERE event_id = $1
       AND (
         status IN ('RECEIVED', 'FAILED')
         OR (status = 'PROCESSING' AND claimed_at < now() - ($2 * interval '1 minute'))
       )
     RETURNING event_type`,
    [eventId, STALE_WEBHOOK_MINUTES]
  );

  if (claim.rows.length === 0) {
    const existing = await pool.query("SELECT status FROM webhook_deliveries WHERE event_id = $1", [eventId]);
    return existing.rows[0]?.status === "PROCESSED" ? "processed" : "busy";
  }

  try {
    const event = await pool.query("SELECT payload FROM events WHERE event_id = $1", [eventId]);
    if (event.rows.length === 0) throw new Error(`Persisted webhook event ${eventId} is missing`);
    const body = event.rows[0].payload;
    const eventType = String(claim.rows[0].event_type);

    if (eventType === "payment.failed") {
      const caseId = await ensureRecoveryCase(pool, eventId);
      if (!caseId) throw new Error("payment.failed payload did not contain a payment entity");
      await logAuditEvent(eventId, "trusted_webhook_ingested", { eventType, caseId });
      setImmediate(() => {
        processPendingRecoveryJobs().catch((error) => console.error("Recovery worker failed:", error));
      });
    } else if (eventType === "payment_link.paid") {
      const paymentLink = body?.payload?.payment_link?.entity;
      if (!paymentLink?.id) throw new Error("Malformed payment_link.paid payload");
      const paidAmount = Number(paymentLink.amount_paid ?? paymentLink.amount ?? 0);
      const transitioned = await markRecoveryFromPaymentLink(
        pool,
        String(paymentLink.id),
        paidAmount,
        paymentLink.reference_id == null ? null : String(paymentLink.reference_id)
      );
      await logAuditEvent(eventId, "recovery_outcome_webhook", {
        eventType,
        paymentLinkId: paymentLink.id,
        referenceId: paymentLink.reference_id ?? null,
        paidAmount,
        transitioned,
      });
    } else if (eventType === "payment.captured") {
      const payment = body?.payload?.payment?.entity;
      if (!payment?.id) throw new Error("Malformed payment.captured payload");
      const stoppedEvents = await markOriginalPaymentCaptured(pool, String(payment.id));
      for (const originalEventId of stoppedEvents) {
        await logAuditEvent(originalEventId, "original_payment_captured_stop", {
          capturedWebhookEventId: eventId,
          paymentId: payment.id,
        });
      }
    }

    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'PROCESSED', processed_at = now(), last_error = NULL, updated_at = now()
       WHERE event_id = $1`,
      [eventId]
    );
    return "processed";
  } catch (error: any) {
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'FAILED', last_error = $2, updated_at = now()
       WHERE event_id = $1`,
      [eventId, error.message]
    );
    throw error;
  }
}

async function persistWebhook(eventId: string, eventType: string, body: any): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO events (event_id, event_type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, eventType, body]
    );
    await client.query(
      `INSERT INTO webhook_deliveries (event_id, event_type, status)
       VALUES ($1, $2, 'RECEIVED')
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, eventType]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function runWorkers(): Promise<void> {
  await Promise.all([processPendingRecoveryJobs(), processDueScheduledActions()]);
}

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
      await persistWebhook(eventId, eventType, body);
      const outcome = await processWebhookDelivery(eventId);
      if (outcome === "busy") {
        res.status(202).send("Webhook is already being processed");
        return;
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
  runWorkers().catch((error) => console.error("Recovery worker startup failed:", error));
  setInterval(() => {
    runWorkers().catch((error) => console.error("Recovery worker poll failed:", error));
  }, WORKER_POLL_MS).unref();
});
