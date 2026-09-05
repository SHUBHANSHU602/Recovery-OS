import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { applyPolicyGate } from "../policy/policyGate";
import { ensureRecoveryCase, ensureTrack3Schema } from "../recovery/recoveryStore";
import { queueRecoveryReplan, scheduleBusinessOutcomeReview } from "../recovery/replanQueue";
import { applySharedPolicy, DECISION_SCENARIOS, scoreActions, staticRulesBaseline } from "../evaluation/aiDecisionBenchmark";
import { buildRecoveryPlannerPrompt, parseRecoveryPlan } from "./recoveryPlanner";
import { loadLatestRecoveryPlan, persistRecoveryPlan } from "./recoveryPlanStore";

async function main() {
  const parsed = parseRecoveryPlan(JSON.stringify({
    objective: "Recover the outstanding amount without excessive customer contact.",
    primary_action: "retry_with_backoff",
    fallback_action: "offer_alternate_payment_method",
    reasoning: "A delayed retry fits the current outage evidence.",
    escalation_criteria: ["retry budget exhausted"],
    stop_conditions: ["trusted payment success", "original payment succeeds or customer opts out"],
  }));
  assert.equal(parsed.primary_action, "retry_with_backoff");
  assert.throws(() => parseRecoveryPlan(JSON.stringify({ ...parsed, primary_action: "charge_card_directly" })));

  const prompt = buildRecoveryPlannerPrompt({
    trigger: "intervention_unresolved",
    rootCause: "insufficient_funds",
    confidence: 0.88,
    amountAtRisk: 50000,
    customerFailureCount: 2,
    correlatedFailuresAtSameBank: 0,
    automatedRetryCount: 1,
    contactsLast24h: 1,
    priorCustomerOutcomes: [],
    strategyEvidence: [{ strategy: "retry_with_backoff", cases: 4, recoveries: 2, recoveryRate: 50, recoveredAmount: 90000 }],
    previousPlan: {
      version: 1,
      trigger: "initial_failure",
      objective: "recover",
      primaryAction: "whatsapp_nudge",
      fallbackAction: "retry_with_backoff",
      reasoning: "initial nudge",
    },
    observation: { priorAction: "whatsapp_nudge", outcome: "unresolved" },
  });
  assert.match(prompt, /Previous recovery plan/);
  assert.match(prompt, /HTTP 429/);
  assert.match(prompt, /infrastructure concerns/);
  assert.match(prompt, /Comparable strategy outcomes/);

  const baseline = scoreActions(
    DECISION_SCENARIOS.map((scenario) =>
      applySharedPolicy(staticRulesBaseline(scenario.context.rootCause), scenario.context)
    )
  );
  assert.equal(baseline.total, 12);
  assert.equal(baseline.correct, 9);

  const pool = new Pool();
  let eventId: string | null = null;
  try {
    await ensureTrack3Schema(pool);
    eventId = `final_ai_test_${randomUUID()}`;
    await pool.query(
      `INSERT INTO events (event_id, event_type, payload)
       VALUES ($1, 'payment.failed', $2)`,
      [eventId, {
        event: "payment.failed",
        payload: { payment: { entity: {
          id: `pay_${randomUUID()}`,
          amount: 50000,
          currency: "INR",
          email: "final-ai-test@example.com",
          bank: "HDFC",
          error_code: "BAD_REQUEST_ERROR",
          error_description: "insufficient funds",
          created_at: Math.floor(Date.now() / 1000) - 60,
        } } },
      }]
    );
    const caseId = await ensureRecoveryCase(pool, eventId);
    assert.ok(caseId);

    const policy = applyPolicyGate({ chosenAction: "retry_with_backoff", automatedRetryCount: 0, contactsLast24h: 0 });
    const saved = await persistRecoveryPlan(pool, {
      caseId: Number(caseId),
      eventId,
      trigger: "initial_failure",
      plan: parsed,
      strategyEvidence: [],
      policy,
    });
    assert.equal(saved.version, 1);
    const latest = await loadLatestRecoveryPlan(pool, Number(caseId));
    assert.equal(latest?.primaryAction, "retry_with_backoff");

    const queued = await queueRecoveryReplan(pool, {
      caseId: Number(caseId),
      eventId,
      trigger: "intervention_unresolved",
      observation: { priorAction: "retry_with_backoff", outcome: "unresolved" },
    });
    assert.equal(queued, true);
    const job = await pool.query(
      "SELECT status, mode, replan_trigger, replan_observation FROM recovery_jobs WHERE case_id = $1",
      [caseId]
    );
    assert.equal(job.rows[0].status, "PENDING");
    assert.equal(job.rows[0].mode, "REPLAN");
    assert.equal(job.rows[0].replan_trigger, "intervention_unresolved");
    assert.equal(job.rows[0].replan_observation.priorAction, "retry_with_backoff");

    await scheduleBusinessOutcomeReview(pool, {
      caseId: Number(caseId),
      eventId,
      action: "retry_with_backoff",
      delaySeconds: 60,
    });
    const review = await pool.query(
      "SELECT desired_action, status FROM scheduled_actions WHERE case_id = $1 AND desired_action = 'ai_outcome_review'",
      [caseId]
    );
    assert.equal(review.rows.length, 1);
    assert.equal(review.rows[0].status, "PENDING");

    console.log("Final AI recovery-agent deterministic tests passed.");
  } finally {
    if (eventId) {
      await pool.query("DELETE FROM recovery_cases WHERE original_event_id = $1", [eventId]);
      await pool.query("DELETE FROM events WHERE event_id = $1", [eventId]);
    }
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Final AI recovery-agent tests failed:", error);
  process.exitCode = 1;
});
