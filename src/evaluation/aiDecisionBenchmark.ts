import "dotenv/config";
import type { CanonicalAction } from "../policy/chooseAction";
import { applyPolicyGate, type ExecutableAction } from "../policy/policyGate";
import {
  applyPlannerBusinessGuardrails,
  planRecovery,
  type RecoveryPlan,
  type RecoveryPlanContext,
} from "../agent/recoveryPlanner";

export interface DecisionScenario {
  id: string;
  expectedAction: ExecutableAction;
  explanation: string;
  context: RecoveryPlanContext;
}

const base: Omit<RecoveryPlanContext, "trigger" | "rootCause"> = {
  confidence: 0.9, amountAtRisk: 250000, customerFailureCount: 1, correlatedFailuresAtSameBank: 0,
  automatedRetryCount: 0, contactsLast24h: 0, priorCustomerOutcomes: [], strategyEvidence: [], previousPlan: null, observation: null,
};

export const DECISION_SCENARIOS: DecisionScenario[] = [
  { id: "outage-first-plan", expectedAction: "issue_recovery_payment_link_after_backoff", explanation: "Strong correlated bank evidence favors waiting before issuing a recovery link.", context: { ...base, trigger: "initial_failure", rootCause: "systemic_bank_outage", correlatedFailuresAtSameBank: 4 } },
  { id: "outage-retry-exhausted", expectedAction: "escalate_to_human", explanation: "The shared policy gate should stop endless automated recovery-link attempts.", context: { ...base, trigger: "intervention_unresolved", rootCause: "systemic_bank_outage", correlatedFailuresAtSameBank: 4, automatedRetryCount: 3, observation: { priorAction: "issue_recovery_payment_link_after_backoff", outcome: "unresolved" } } },
  { id: "expired-card-first-plan", expectedAction: "offer_alternate_payment_method", explanation: "Expired-card evidence favors another instrument.", context: { ...base, trigger: "initial_failure", rootCause: "expired_card" } },
  { id: "expired-card-contact-cap", expectedAction: "escalate_to_human", explanation: "The shared contact policy blocks another customer contact after the cap is consumed.", context: { ...base, trigger: "intervention_unresolved", rootCause: "expired_card", contactsLast24h: 1, observation: { priorAction: "offer_alternate_payment_method", outcome: "unresolved" } } },
  {
    id: "expired-card-repeated-alternate-unresolved", expectedAction: "escalate_to_human", explanation: "Contextual planning should recognize that the same alternate-method strategy repeatedly failed.",
    context: { ...base, trigger: "intervention_unresolved", rootCause: "expired_card", customerFailureCount: 4, contactsLast24h: 0,
      previousPlan: { version: 2, trigger: "intervention_unresolved", objective: "Recover through a usable payment instrument.", primaryAction: "offer_alternate_payment_method", fallbackAction: "escalate_to_human", reasoning: "Earlier alternate-method outreach was attempted." },
      observation: { priorAction: "offer_alternate_payment_method", outcome: "unresolved_after_repeated_customer_specific_attempt" },
      strategyEvidence: [{ strategy: "offer_alternate_payment_method", cases: 7, recoveries: 1, recoveryRate: 14.3, recoveredAmount: 100000 }, { strategy: "escalate_to_human", cases: 5, recoveries: 0, recoveryRate: 0, recoveredAmount: 0 }] },
  },
  { id: "insufficient-funds-nudge", expectedAction: "whatsapp_nudge", explanation: "A customer-specific insufficient-funds case can justify one bounded nudge.", context: { ...base, trigger: "initial_failure", rootCause: "insufficient_funds" } },
  {
    id: "insufficient-funds-prior-nudge-failed", expectedAction: "issue_recovery_payment_link_after_backoff", explanation: "Stronger recovery-link history should change strategy after a nudge failed.",
    context: { ...base, trigger: "intervention_unresolved", rootCause: "insufficient_funds", contactsLast24h: 0, observation: { priorAction: "whatsapp_nudge", outcome: "unresolved" },
      strategyEvidence: [{ strategy: "whatsapp_nudge", cases: 8, recoveries: 1, recoveryRate: 12.5, recoveredAmount: 120000 }, { strategy: "issue_recovery_payment_link_after_backoff", cases: 9, recoveries: 5, recoveryRate: 55.6, recoveredAmount: 740000 }] },
  },
  { id: "ambiguous-high-value", expectedAction: "escalate_to_human", explanation: "Ambiguous evidence should abstain.", context: { ...base, trigger: "initial_failure", rootCause: "ambiguous", confidence: 0.45, amountAtRisk: 900000 } },
  { id: "ambiguous-low-confidence", expectedAction: "escalate_to_human", explanation: "Low-confidence ambiguity is an abstention case.", context: { ...base, trigger: "initial_failure", rootCause: "ambiguous", confidence: 0.25 } },
  { id: "promise-due-insufficient-funds", expectedAction: "whatsapp_nudge", explanation: "A due unpaid promise can justify one compliant reminder.", context: { ...base, trigger: "promise_due_unpaid", rootCause: "insufficient_funds", observation: { promisedAmount: 250000, outcome: "promise_due_and_case_still_unresolved" } } },
  { id: "promise-due-contact-cap", expectedAction: "escalate_to_human", explanation: "The shared policy blocks another automated contact after the cap.", context: { ...base, trigger: "promise_due_unpaid", rootCause: "insufficient_funds", contactsLast24h: 1, observation: { promisedAmount: 250000, outcome: "promise_due_and_case_still_unresolved" } } },
  {
    id: "outage-evidence-shifts-to-poor-retry-history", expectedAction: "escalate_to_human", explanation: "Poor recovery-link outcomes should stop mechanical repetition.",
    context: { ...base, trigger: "intervention_unresolved", rootCause: "systemic_bank_outage", correlatedFailuresAtSameBank: 4, automatedRetryCount: 1,
      previousPlan: { version: 1, trigger: "initial_failure", objective: "Wait through the bank outage and recover later.", primaryAction: "issue_recovery_payment_link_after_backoff", fallbackAction: "escalate_to_human", reasoning: "Initial outage evidence favored delay." },
      observation: { priorAction: "issue_recovery_payment_link_after_backoff", outcome: "unresolved_after_business_review" },
      strategyEvidence: [{ strategy: "issue_recovery_payment_link_after_backoff", cases: 10, recoveries: 1, recoveryRate: 10, recoveredAmount: 90000 }] },
  },
];

export function staticRulesBaseline(rootCause: string): CanonicalAction {
  if (rootCause === "systemic_bank_outage") return "issue_recovery_payment_link_after_backoff";
  if (rootCause === "expired_card") return "offer_alternate_payment_method";
  if (rootCause === "insufficient_funds") return "whatsapp_nudge";
  return "escalate_to_human";
}

function deterministicSeedPlan(context: RecoveryPlanContext): RecoveryPlan {
  return {
    objective: "Recover safely using deterministic contextual planning.", primary_action: staticRulesBaseline(context.rootCause), fallback_action: "escalate_to_human",
    reasoning: "Deterministic root-cause seed before the same contextual business guardrails used by the AI arm.", escalation_criteria: ["bounded automation is no longer appropriate"], stop_conditions: ["trusted payment success", "original payment success or customer opt-out"],
  };
}

export function contextAwareDeterministicPlanner(context: RecoveryPlanContext): CanonicalAction {
  return applyPlannerBusinessGuardrails(context, deterministicSeedPlan(context)).primary_action;
}

export function applySharedPolicy(action: CanonicalAction, context: RecoveryPlanContext): ExecutableAction {
  return applyPolicyGate({ chosenAction: action, automatedRetryCount: context.automatedRetryCount, contactsLast24h: context.contactsLast24h }).finalAction;
}

export function scoreActions(predictions: ExecutableAction[]): { correct: number; total: number; accuracy: number } {
  if (predictions.length !== DECISION_SCENARIOS.length) throw new Error("Prediction count must match decision scenarios");
  const correct = predictions.filter((prediction, index) => prediction === DECISION_SCENARIOS[index].expectedAction).length;
  return { correct, total: predictions.length, accuracy: predictions.length ? (correct / predictions.length) * 100 : 0 };
}

export async function runAiDecisionBenchmark() {
  const deterministicPredictions = DECISION_SCENARIOS.map((scenario) => applySharedPolicy(contextAwareDeterministicPlanner(scenario.context), scenario.context));
  const aiPredictions: ExecutableAction[] = [];
  const details: Array<{ id: string; expected: ExecutableAction; deterministic: ExecutableAction; ai: ExecutableAction; explanation: string }> = [];
  for (let index = 0; index < DECISION_SCENARIOS.length; index += 1) {
    const scenario = DECISION_SCENARIOS[index];
    const plan = await planRecovery(scenario.context);
    const aiFinalAction = applySharedPolicy(plan.primary_action, scenario.context);
    aiPredictions.push(aiFinalAction);
    details.push({ id: scenario.id, expected: scenario.expectedAction, deterministic: deterministicPredictions[index], ai: aiFinalAction, explanation: scenario.explanation });
  }
  return {
    evidenceClass: "labeled contextual decision benchmark: both arms receive identical contextual guardrails and the same deterministic policy; not recovered revenue",
    deterministic: scoreActions(deterministicPredictions), ai: scoreActions(aiPredictions), details,
  };
}

if (require.main === module) {
  runAiDecisionBenchmark().then((result) => {
    console.log("========== AI VS CONTEXT-AWARE DETERMINISTIC BENCHMARK ==========");
    console.log("NOTE: both arms receive the same contextual business guardrails and the same deterministic policy gate. This measures decision quality, NOT provider-confirmed revenue lift.");
    console.log(`Context-aware deterministic planner + shared guardrails + policy: ${result.deterministic.correct}/${result.deterministic.total} (${result.deterministic.accuracy.toFixed(1)}%)`);
    console.log(`AI contextual planner + shared guardrails + policy: ${result.ai.correct}/${result.ai.total} (${result.ai.accuracy.toFixed(1)}%)`);
    for (const item of result.details) console.log(`${item.id}: expected=${item.expected}; deterministic=${item.deterministic}; ai=${item.ai}`);
  }).catch((error) => { console.error("AI decision benchmark failed:", error); process.exitCode = 1; });
}
