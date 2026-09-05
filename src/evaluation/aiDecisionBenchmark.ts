import "dotenv/config";
import type { Action } from "../policy/chooseAction";
import { planRecovery, type RecoveryPlanContext } from "../agent/recoveryPlanner";

export interface DecisionScenario {
  id: string;
  expectedAction: Action;
  explanation: string;
  context: RecoveryPlanContext;
}

const base: Omit<RecoveryPlanContext, "trigger" | "rootCause"> = {
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

export const DECISION_SCENARIOS: DecisionScenario[] = [
  {
    id: "outage-first-plan",
    expectedAction: "retry_with_backoff",
    explanation: "Strong correlated bank evidence favors waiting rather than immediate customer friction.",
    context: { ...base, trigger: "initial_failure", rootCause: "systemic_bank_outage", correlatedFailuresAtSameBank: 4 },
  },
  {
    id: "outage-retry-exhausted",
    expectedAction: "escalate_to_human",
    explanation: "The same diagnosis should not cause endless automation after the retry budget is exhausted.",
    context: { ...base, trigger: "intervention_unresolved", rootCause: "systemic_bank_outage", correlatedFailuresAtSameBank: 4, automatedRetryCount: 3, observation: { priorAction: "retry_with_backoff", outcome: "unresolved" } },
  },
  {
    id: "expired-card-first-plan",
    expectedAction: "offer_alternate_payment_method",
    explanation: "Expired-card evidence favors another instrument rather than repeating the same path.",
    context: { ...base, trigger: "initial_failure", rootCause: "expired_card" },
  },
  {
    id: "expired-card-contact-cap",
    expectedAction: "escalate_to_human",
    explanation: "A useful recommendation must react to the contact constraint instead of repeating alternate-method outreach.",
    context: { ...base, trigger: "intervention_unresolved", rootCause: "expired_card", contactsLast24h: 1, observation: { priorAction: "offer_alternate_payment_method", outcome: "unresolved" } },
  },
  {
    id: "insufficient-funds-nudge",
    expectedAction: "whatsapp_nudge",
    explanation: "A customer-specific insufficient-funds case can justify one bounded customer nudge.",
    context: { ...base, trigger: "initial_failure", rootCause: "insufficient_funds" },
  },
  {
    id: "insufficient-funds-prior-nudge-failed",
    expectedAction: "retry_with_backoff",
    explanation: "An unresolved prior nudge should change strategy when delayed retry has stronger comparable outcomes.",
    context: {
      ...base,
      trigger: "intervention_unresolved",
      rootCause: "insufficient_funds",
      contactsLast24h: 1,
      observation: { priorAction: "whatsapp_nudge", outcome: "unresolved" },
      strategyEvidence: [
        { strategy: "whatsapp_nudge", cases: 8, recoveries: 1, recoveryRate: 12.5, recoveredAmount: 120000 },
        { strategy: "retry_with_backoff", cases: 9, recoveries: 5, recoveryRate: 55.6, recoveredAmount: 740000 },
      ],
    },
  },
  {
    id: "ambiguous-high-value",
    expectedAction: "escalate_to_human",
    explanation: "Ambiguous evidence should abstain rather than automate a confident financial recovery path.",
    context: { ...base, trigger: "initial_failure", rootCause: "ambiguous", confidence: 0.45, amountAtRisk: 900000 },
  },
  {
    id: "ambiguous-low-confidence",
    expectedAction: "escalate_to_human",
    explanation: "Low-confidence ambiguity is intentionally an abstention case.",
    context: { ...base, trigger: "initial_failure", rootCause: "ambiguous", confidence: 0.25 },
  },
  {
    id: "promise-due-insufficient-funds",
    expectedAction: "whatsapp_nudge",
    explanation: "A due unpaid customer promise is new business evidence that can justify one compliant reminder/nudge.",
    context: { ...base, trigger: "promise_due_unpaid", rootCause: "insufficient_funds", observation: { promisedAmount: 250000, outcome: "promise_due_and_case_still_unresolved" } },
  },
  {
    id: "promise-due-contact-cap",
    expectedAction: "escalate_to_human",
    explanation: "The same due promise must not trigger another automated contact when today's cap is already consumed.",
    context: { ...base, trigger: "promise_due_unpaid", rootCause: "insufficient_funds", contactsLast24h: 1, observation: { promisedAmount: 250000, outcome: "promise_due_and_case_still_unresolved" } },
  },
];

export function staticRulesBaseline(rootCause: string): Action {
  if (rootCause === "systemic_bank_outage") return "retry_with_backoff";
  if (rootCause === "expired_card") return "offer_alternate_payment_method";
  if (rootCause === "insufficient_funds") return "whatsapp_nudge";
  return "escalate_to_human";
}

export function scoreActions(predictions: Action[]): { correct: number; total: number; accuracy: number } {
  if (predictions.length !== DECISION_SCENARIOS.length) throw new Error("Prediction count must match decision scenarios");
  const correct = predictions.filter((prediction, index) => prediction === DECISION_SCENARIOS[index].expectedAction).length;
  return { correct, total: predictions.length, accuracy: predictions.length ? (correct / predictions.length) * 100 : 0 };
}

export async function runAiDecisionBenchmark() {
  const baselinePredictions = DECISION_SCENARIOS.map((scenario) => staticRulesBaseline(scenario.context.rootCause));
  const aiPredictions: Action[] = [];
  const details: Array<{ id: string; expected: Action; baseline: Action; ai: Action; explanation: string }> = [];

  for (let index = 0; index < DECISION_SCENARIOS.length; index += 1) {
    const scenario = DECISION_SCENARIOS[index];
    const plan = await planRecovery(scenario.context);
    aiPredictions.push(plan.primary_action);
    details.push({
      id: scenario.id,
      expected: scenario.expectedAction,
      baseline: baselinePredictions[index],
      ai: plan.primary_action,
      explanation: scenario.explanation,
    });
  }

  return {
    evidenceClass: "labeled contextual decision benchmark; not recovered revenue",
    baseline: scoreActions(baselinePredictions),
    ai: scoreActions(aiPredictions),
    details,
  };
}

if (require.main === module) {
  runAiDecisionBenchmark()
    .then((result) => {
      console.log("========== AI VS STATIC RULES DECISION BENCHMARK ==========");
      console.log("NOTE: labeled contextual decision benchmark; NOT provider-confirmed revenue lift.");
      console.log(`Static rules: ${result.baseline.correct}/${result.baseline.total} (${result.baseline.accuracy.toFixed(1)}%)`);
      console.log(`AI recovery planner: ${result.ai.correct}/${result.ai.total} (${result.ai.accuracy.toFixed(1)}%)`);
      for (const item of result.details) {
        console.log(`${item.id}: expected=${item.expected}; baseline=${item.baseline}; ai=${item.ai}`);
      }
    })
    .catch((error) => {
      console.error("AI decision benchmark failed:", error);
      process.exitCode = 1;
    });
}
