import { Router, type Request } from "express";
import type { Pool } from "pg";
import { POLICY_LIMITS } from "../policy/policyGate";
import { DEFAULT_CONTACT_WINDOW, refreshRecoveryPriority } from "../intelligence/recoveryIntelligence";
import { createPromiseToPay, listPromisesForCase } from "../intelligence/paymentPromises";
import { runAgentTurn } from "../agent/conversationalAgent";
import { requestPaymentLink, recordOutboundContact } from "../execution/actionService";
import { scheduleBackoffRetry } from "../execution/scheduledActions";
import { createHumanEscalation } from "../recovery/recoveryStore";
import { logAuditEvent } from "../ledger/auditLog";
import {
  getDashboardSummary,
  getRecoveryCase,
  getRecoveryCaseTimeline,
  listHumanEscalations,
  listRecoveryCases,
  listRecoveryPaymentLinks,
} from "./dashboardService";
import { getCaseConversation, getCaseRuntimeState, listRecentActivity } from "./liveConsoleService";

function testConsoleEnabled(req: Request): boolean {
  if (process.env.RECOVERY_ENABLE_TEST_CONSOLE !== "true") return false;
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function requireTestConsole(req: Request): void {
  if (!testConsoleEnabled(req)) throw new Error("Local test console is disabled. Set RECOVERY_ENABLE_TEST_CONSOLE=true and access from localhost.");
}

export function createDashboardRouter(pool: Pool) {
  const router = Router();

  router.get("/summary", async (_req, res) => {
    try { res.json(await getDashboardSummary(pool)); }
    catch (error: any) { console.error("Dashboard summary failed:", error.message); res.status(500).json({ error: "Unable to load dashboard summary" }); }
  });

  router.get("/live/status", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ live: true, database: "connected", generatedAt: new Date().toISOString(), pollSeconds: 3, testConsoleEnabled: testConsoleEnabled(req) });
    } catch (error: any) { res.status(503).json({ live: false, database: "unavailable", error: error.message }); }
  });

  router.get("/activity", async (req, res) => {
    try { const limit = Number(req.query.limit ?? 40); res.json(await listRecentActivity(pool, Number.isFinite(limit) ? limit : 40)); }
    catch (error: any) { console.error("Dashboard activity failed:", error.message); res.status(500).json({ error: "Unable to load live recovery activity" }); }
  });

  router.get("/cases", async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 50); const offset = Number(req.query.offset ?? 0);
      res.json(await listRecoveryCases(pool, {
        status: typeof req.query.status === "string" ? req.query.status : null,
        search: typeof req.query.search === "string" ? req.query.search : null,
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
      }));
    } catch (error: any) { console.error("Dashboard cases failed:", error.message); res.status(500).json({ error: "Unable to load recovery cases" }); }
  });

  router.get("/cases/:caseId", async (req, res) => {
    try {
      const caseId = Number(req.params.caseId); if (!Number.isInteger(caseId) || caseId <= 0) return void res.status(400).json({ error: "Invalid recovery case id" });
      const item = await getRecoveryCase(pool, caseId); if (!item) return void res.status(404).json({ error: "Recovery case not found" });
      res.json(item);
    } catch (error: any) { console.error("Dashboard case detail failed:", error.message); res.status(500).json({ error: "Unable to load recovery case" }); }
  });

  router.get("/cases/:caseId/payment-links", async (req, res) => {
    try {
      const caseId = Number(req.params.caseId); if (!Number.isInteger(caseId) || caseId <= 0) return void res.status(400).json({ error: "Invalid recovery case id" });
      const item = await getRecoveryCase(pool, caseId); if (!item) return void res.status(404).json({ error: "Recovery case not found" });
      res.json(await listRecoveryPaymentLinks(pool, caseId));
    } catch (error: any) { res.status(500).json({ error: "Unable to load Payment Link history" }); }
  });

  router.get("/cases/:caseId/runtime", async (req, res) => {
    try {
      const caseId = Number(req.params.caseId); if (!Number.isInteger(caseId) || caseId <= 0) return void res.status(400).json({ error: "Invalid recovery case id" });
      const result = await getCaseRuntimeState(pool, caseId); if (!result) return void res.status(404).json({ error: "Recovery case not found" }); res.json(result);
    } catch { res.status(500).json({ error: "Unable to load case runtime state" }); }
  });

  router.get("/cases/:caseId/conversation", async (req, res) => {
    try { const result = await getCaseConversation(pool, Number(req.params.caseId)); if (!result) return void res.status(404).json({ error: "Recovery case not found" }); res.json(result); }
    catch { res.status(500).json({ error: "Unable to load recovery conversation" }); }
  });

  router.post("/cases/:caseId/conversation", async (req, res) => {
    try {
      requireTestConsole(req); const caseId = Number(req.params.caseId); const message = String(req.body?.message ?? "").trim();
      if (!message) return void res.status(400).json({ error: "message is required" });
      const item = await getRecoveryCase(pool, caseId); if (!item) return void res.status(404).json({ error: "Recovery case not found" });
      if (!item.customerEmail) return void res.status(409).json({ error: "Recovery case has no customer email" });
      res.json({ reply: await runAgentTurn(item.originalEventId, item.customerEmail, item.amountAtRisk, message) });
    } catch (error: any) { res.status(409).json({ error: error.message }); }
  });

  router.post("/cases/:caseId/test-action", async (req, res) => {
    try {
      requireTestConsole(req); const caseId = Number(req.params.caseId); const action = String(req.body?.action ?? "");
      const item = await getRecoveryCase(pool, caseId); if (!item) return void res.status(404).json({ error: "Recovery case not found" });
      if (action === "refresh_priority") return void res.json(await refreshRecoveryPriority(pool, caseId));
      if (action === "issue_recovery_payment_link" || action === "retry_now") {
        return void res.json(await requestPaymentLink(item.originalEventId, "retry_now", null, `${item.originalEventId}_console_issue_link_${Date.now()}`));
      }
      if (action === "issue_recovery_payment_link_after_backoff" || action === "retry_with_backoff") {
        await scheduleBackoffRetry(item.originalEventId, null, 1); return void res.json({ status: "scheduled", delaySeconds: 1 });
      }
      if (action === "whatsapp_nudge" || action === "offer_alternate_payment_method") {
        const opening = action === "whatsapp_nudge" ? "Hi! We noticed your recent payment did not go through. Would you like a fresh payment link to try again?" : "Hi! Your payment could not be completed. Would you like to try a different payment method?";
        return void res.json(await recordOutboundContact(item.originalEventId, action, opening));
      }
      if (action === "escalate_to_human") {
        await createHumanEscalation(pool, caseId, item.originalEventId, "merchant_console_test_escalation");
        await logAuditEvent(item.originalEventId, "merchant_console_test_escalation", { caseId }); return void res.json({ status: "escalated" });
      }
      res.status(400).json({ error: "Unsupported test action" });
    } catch (error: any) { res.status(409).json({ error: error.message }); }
  });

  router.post("/cases/:caseId/priority/refresh", async (req, res) => {
    try { const caseId = Number(req.params.caseId); if (!Number.isInteger(caseId) || caseId <= 0) return void res.status(400).json({ error: "Invalid recovery case id" }); res.json(await refreshRecoveryPriority(pool, caseId)); }
    catch (error: any) { res.status(400).json({ error: error.message }); }
  });

  router.get("/cases/:caseId/promises", async (req, res) => {
    try { const caseId = Number(req.params.caseId); if (!Number.isInteger(caseId) || caseId <= 0) return void res.status(400).json({ error: "Invalid recovery case id" }); res.json({ items: await listPromisesForCase(pool, caseId) }); }
    catch { res.status(500).json({ error: "Unable to load payment promises" }); }
  });

  router.post("/cases/:caseId/promises", async (req, res) => {
    try {
      const caseId = Number(req.params.caseId); const promisedAmount = req.body?.promisedAmount == null ? null : Number(req.body.promisedAmount); const dueAt = new Date(String(req.body?.dueAt ?? ""));
      if (!Number.isInteger(caseId) || caseId <= 0) return void res.status(400).json({ error: "Invalid recovery case id" });
      if (promisedAmount != null && (!Number.isFinite(promisedAmount) || promisedAmount <= 0)) return void res.status(400).json({ error: "promisedAmount must be a positive paise value" });
      if (Number.isNaN(dueAt.getTime())) return void res.status(400).json({ error: "dueAt must be a valid date/time" });
      res.status(201).json(await createPromiseToPay(pool, { caseId, promisedAmount, dueAt, source: typeof req.body?.source === "string" ? req.body.source : "merchant_dashboard", note: typeof req.body?.note === "string" ? req.body.note : null }));
    } catch (error: any) { res.status(400).json({ error: error.message }); }
  });

  router.get("/cases/:caseId/timeline", async (req, res) => {
    try { const caseId = Number(req.params.caseId); if (!Number.isInteger(caseId) || caseId <= 0) return void res.status(400).json({ error: "Invalid recovery case id" }); const timeline = await getRecoveryCaseTimeline(pool, caseId); if (!timeline) return void res.status(404).json({ error: "Recovery case not found" }); res.json(timeline); }
    catch (error: any) { console.error("Dashboard timeline failed:", error.message); res.status(500).json({ error: "Unable to load audit timeline" }); }
  });

  router.get("/escalations", async (req, res) => {
    try { const limit = Number(req.query.limit ?? 100); res.json(await listHumanEscalations(pool, Number.isFinite(limit) ? limit : 100)); }
    catch (error: any) { console.error("Dashboard escalations failed:", error.message); res.status(500).json({ error: "Unable to load human escalations" }); }
  });

  router.get("/policy", (_req, res) => res.json({
    mode: "deterministic", maxAutomatedRetries: POLICY_LIMITS.maxAutomatedRetries, maxContactsPerDay: POLICY_LIMITS.maxContactsPerDay,
    recoveredCaseBehavior: "stop", optedOutBehavior: "stop", ambiguousExecutionBehavior: "fail_closed_and_escalate",
    quietHours: { timeZone: DEFAULT_CONTACT_WINDOW.timeZone, startHour: DEFAULT_CONTACT_WINDOW.quietStartHour, endHour: DEFAULT_CONTACT_WINDOW.quietEndHour, behavior: "defer_until_allowed_window" },
    prioritization: "expected_recovery_value = amount_at_risk × smoothed historical recovery probability",
    promiseToPay: "durable promise + reminder scheduling + provider-outcome fulfillment",
  }));

  return router;
}
