import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { applyPolicyGate } from "../policy/policyGate";
import { ensureRecoveryCase, ensureTrack3Schema } from "../recovery/recoveryStore";
import { queueRecoveryReplan, scheduleBusinessOutcomeReview } from "../recovery/replanQueue";
import { applySharedPolicy, DECISION_SCENARIOS, scoreActions, staticRulesBaseline } from "../evaluation/aiDecisionBenchmark";
import {
  applyPlannerBusinessGuardrails,
  buildRecoveryPlannerPrompt,
  parseRecoveryPlan,
  type RecoveryPlan,
  type RecoveryPlanContext,
} from "./recoveryPlanner";
import { loadLatestRecoveryPlan, persistRecoveryPlan } from "./recoveryPlanStore";

const samplePlan: RecoveryPlan = {
  objective: "Recover safely.",
  primary_action: "offer_alternate_payment_method",
  fallback_action: "whatsapp_nudge",
  reasoning: "Model recommendation for regression testing.",
  escalation_criteria: ["bounded automation no longer appropriate"],
  stop_conditions: ["trusted payment success", "original payment succeeds or customer opts out"],
};

const baseContext: RecoveryPlanContext = {
  trigger: "initial_failure",
  rootCause: "insufficient_funds",
  confidence: 0.9,
  amountAtRisk: 250000,
  customerFailureCount: 1,
  correlatedFailuresAtSameBank: 0,
  automatedRetryCount: 0,
  contactsLast24h: 0,
  priorCustomerOutcomes: [],
  strategyEvidence: [],
  previousPlan: null,
  observation: null,
};

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
  assert.match(prompt, /Decision priorities/);

  // Business guardrails are context-derived invariants, not benchmark ids.
  assert.equal(
    applyPlannerBusinessGuardrails(
      { ...baseContext, trigger: "intervention_unresolved", rootCause: "systemic_bank_outage", automatedRetryCount: 3 },
      samplePlan
    ).primary_action,
    "escalate_to_human"
  );
  assert.equal(
    applyPlannerBusinessGuardrails(
      { ...baseContext, rootCause: "ambiguous", confidence: 0.25 },
      samplePlan
    ).primary_action,
    "escalate_to_human"
  );
  assert.equal(
    applyPlannerBusinessGuardrails(baseContext, samplePlan).primary_action,
    "whatsapp_nudge"
  );
  assert.equal(
    applyPlannerBusinessGuardrails(
      {
        ...baseContext,
        trigger: "promise_due_unpaid",
        rootCause: "insufficient_funds",
        contactsLast24h: 1,
        observation: { outcome: "promise_due_and_case_still_unresolved" },
      },
      samplePlan
    ).primary_action,
    "escalate_to_human"
  );
  assert.equal(
    applyPlannerBusinessGuardrails(
      {
        ...baseContext,
        trigger: "intervention_unresolved",
        rootCause: "insufficient_funds",
        observation: { priorAction: "whatsapp_nudge", outcome: "unresolved" },
        strategyEvidence: [
          { strategy: "whatsapp_nudge", cases: 8, recoveries: 1, recoveryRate: 12.5, recoveredAmount: 120000 },
          { strategy: "retry_with_backoff", cases: 9, recoveries: 5, recoveryRate: 55.6, recoveredAmount: 740000 },
        ],
      },
      samplePlan
    ).primary_action,
    "retry_with_backoff"
  );
  assert.equal(
    applyPlannerBusinessGuardrails(
      {
        ...baseContext,
        trigger: "intervention_unresolved",
        rootCause: "systemic_bank_outage",
        correlatedFailuresAtSameBank: 4,
        automatedRetryCount: 1,
        observation: { priorAction: "retry_with_backoff", outcome: "unresolved_after_business_review" },
        previousPlan: {
          version: 1,
          trigger: "initial_failure",
          objective: "wait through outage",
          primaryAction: "retry_with_backoff",
          fallbackAction: "escalate_to_human",
          reasoning: "outage evidence",
        },
        strategyEvidence: [
          { strategy: "retry_with_backoff", cases: 10, recoveries: 1, recoveryRate: 10, recoveredAmount: 90000 },
        ],
      },
      samplePlan
    ).primary_action,
    "escalate_to_human"
  );

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
