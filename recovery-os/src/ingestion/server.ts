import "dotenv/config";
import express, { Request, Response } from "express";
import { Pool } from "pg";
import { verifyRazorpayWebhookSignature } from "./verifyWebhookSignature";
import { processRecoveryEvent } from "../pipeline/processRecoveryEvent";
import { recordRecoveryFromWebhook } from "../recovery/recordRecovery";
import { runDueScheduledActions } from "../execution/scheduler";
import { logAuditEvent } from "../ledger/auditLog";

const app = express();
const pool = new Pool();

function dispatchStoredEvent(eventId: string, eventType: string, body: any) {
  if (eventType === "payment.failed") {
    void processRecoveryEvent(eventId).catch(async (err: any) => {
      console.error(`Recovery pipeline failed for ${eventId}:`, err.message);
      try {
        await logAuditEvent(eventId, "pipeline_error", { error: err.message });
      } catch (auditErr) {
        console.error("Could not write pipeline_error audit record:", auditErr);
      }
    });
  } else if (eventType === "payment_link.paid" || eventType === "payment.captured") {
    void recordRecoveryFromWebhook(eventId, body).catch((err: any) => {
      console.error(`Recovery confirmation failed for ${eventId}:`, err.message);
    });
  }
}

app.post("/webhooks/razorpay", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
  const eventId = req.headers["x-razorpay-event-id"] as string | undefined;
  const signature = req.headers["x-razorpay-signature"] as string | undefined;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const rawBody = req.body as Buffer;

  if (!eventId) {
    res.status(400).send("Missing event id");
    return;
  }
  if (!signature) {
    res.status(401).send("Missing webhook signature");
    return;
  }
  if (!webhookSecret) {
    console.error("RAZORPAY_WEBHOOK_SECRET is not configured.");
    res.status(500).send("Webhook secret not configured");
    return;
  }
  if (!verifyRazorpayWebhookSignature(rawBody, signature, webhookSecret)) {
    console.warn(`Rejected webhook ${eventId}: invalid signature.`);
    res.status(401).send("Invalid webhook signature");
    return;
  }

  let body: any;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).send("Invalid JSON");
    return;
  }

  const eventType = body.event as string;
  let duplicate = false;

  try {
    await pool.query("INSERT INTO events (event_id, event_type, payload) VALUES ($1, $2, $3)", [eventId, eventType, body]);
  } catch (err: any) {
    if (err.code === "23505") {
      duplicate = true;
    } else {
      console.error("DB error:", err.message);
      res.status(500).send("Internal error");
      return;
    }
  }

  res.status(200).send(duplicate ? "Already stored; processing replayed safely" : "OK");
  dispatchStoredEvent(eventId, eventType, body);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Server listening on http://localhost:${port}`));

const workerIntervalMs = Number(process.env.RECOVERY_WORKER_INTERVAL_MS ?? 15000);
setInterval(() => {
  void runDueScheduledActions().catch((err) => console.error("Scheduled recovery worker failed:", err));
}, workerIntervalMs).unref();
