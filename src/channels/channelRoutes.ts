import { Router } from "express";
import type { Pool } from "pg";
import {
  getChannelProviderStatus,
  listChannelDeliveries,
  sendRecoveryChannel,
  type RecoveryChannel,
} from "./channelService";

const ALLOWED_CHANNELS = new Set<RecoveryChannel>(["email", "sms", "whatsapp", "voice"]);

export function createChannelRouter(pool: Pool) {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({ providers: getChannelProviderStatus() });
  });

  router.get("/deliveries", async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 100);
      res.json({ items: await listChannelDeliveries(pool, Number.isFinite(limit) ? limit : 100) });
    } catch (error: any) {
      console.error("Channel deliveries failed:", error.message);
      res.status(500).json({ error: "Unable to load channel deliveries" });
    }
  });

  router.post("/cases/:caseId/send", async (req, res) => {
    try {
      const caseId = Number(req.params.caseId);
      if (!Number.isInteger(caseId) || caseId <= 0) {
        res.status(400).json({ error: "Invalid recovery case id" });
        return;
      }
      const channel = String(req.body?.channel ?? "") as RecoveryChannel;
      if (!ALLOWED_CHANNELS.has(channel)) {
        res.status(400).json({ error: "channel must be email, sms, whatsapp, or voice" });
        return;
      }
      const result = await sendRecoveryChannel(pool, {
        caseId,
        channel,
        message: typeof req.body?.message === "string" ? req.body.message : null,
      });
      res.status(201).json(result);
    } catch (error: any) {
      const message = String(error.message ?? error);
      const status = /does not exist/.test(message) ? 404 : /terminal|cap reached|No /.test(message) ? 409 : 500;
      if (status === 500) console.error("Channel send failed:", message);
      res.status(status).json({ error: message });
    }
  });

  return router;
}
