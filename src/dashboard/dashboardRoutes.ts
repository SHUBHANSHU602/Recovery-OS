import { Router } from "express";
import type { Pool } from "pg";
import {
  getDashboardSummary,
  getRecoveryCase,
  getRecoveryCaseTimeline,
  listHumanEscalations,
  listRecoveryCases,
} from "./dashboardService";

export function createDashboardRouter(pool: Pool) {
  const router = Router();

  router.get("/summary", async (_req, res) => {
    try {
      res.json(await getDashboardSummary(pool));
    } catch (error: any) {
      console.error("Dashboard summary failed:", error.message);
      res.status(500).json({ error: "Unable to load dashboard summary" });
    }
  });

  router.get("/cases", async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 50);
      const offset = Number(req.query.offset ?? 0);
      const result = await listRecoveryCases(pool, {
        status: typeof req.query.status === "string" ? req.query.status : null,
        search: typeof req.query.search === "string" ? req.query.search : null,
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Dashboard cases failed:", error.message);
      res.status(500).json({ error: "Unable to load recovery cases" });
    }
  });

  router.get("/cases/:caseId", async (req, res) => {
    try {
      const caseId = Number(req.params.caseId);
      if (!Number.isInteger(caseId) || caseId <= 0) {
        res.status(400).json({ error: "Invalid recovery case id" });
        return;
      }
      const item = await getRecoveryCase(pool, caseId);
      if (!item) {
        res.status(404).json({ error: "Recovery case not found" });
        return;
      }
      res.json(item);
    } catch (error: any) {
      console.error("Dashboard case detail failed:", error.message);
      res.status(500).json({ error: "Unable to load recovery case" });
    }
  });

  router.get("/cases/:caseId/timeline", async (req, res) => {
    try {
      const caseId = Number(req.params.caseId);
      if (!Number.isInteger(caseId) || caseId <= 0) {
        res.status(400).json({ error: "Invalid recovery case id" });
        return;
      }
      const timeline = await getRecoveryCaseTimeline(pool, caseId);
      if (!timeline) {
        res.status(404).json({ error: "Recovery case not found" });
        return;
      }
      res.json(timeline);
    } catch (error: any) {
      console.error("Dashboard timeline failed:", error.message);
      res.status(500).json({ error: "Unable to load audit timeline" });
    }
  });

  router.get("/escalations", async (req, res) => {
    try {
      const limit = Number(req.query.limit ?? 100);
      res.json(await listHumanEscalations(pool, Number.isFinite(limit) ? limit : 100));
    } catch (error: any) {
      console.error("Dashboard escalations failed:", error.message);
      res.status(500).json({ error: "Unable to load human escalations" });
    }
  });

  router.get("/policy", (_req, res) => {
    res.json({
      mode: "deterministic",
      maxAutomatedRetries: 3,
      maxContactsPerDay: 1,
      recoveredCaseBehavior: "stop",
      optedOutBehavior: "stop",
      ambiguousExecutionBehavior: "fail_closed_and_escalate",
      quietHours: null,
      note: "Quiet-hour scheduling is planned for Phase B. Current limits are enforced by the deterministic policy gate.",
    });
  });

  return router;
}
