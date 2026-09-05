import "dotenv/config";
import Groq from "groq-sdk";
import type { Action } from "../policy/chooseAction";

const ALLOWED_ACTIONS: Action[] = [
  "retry_now",
  "retry_with_backoff",
  "offer_alternate_payment_method",
  "whatsapp_nudge",
  "escalate_to_human",
];

export type RecoveryPlanTrigger =
  | "initial_failure"
  | "intervention_unresolved"
  | "customer_reply"
  | "promise_due_unpaid";

export interface StrategyEvidence {
  strategy: string;
  cases: number;
  recoveries: number;
  recoveryRate: number;
  recoveredAmount: number;
}

export interface PersistedPlanSummary {
  version: number;
  trigger: string;
  objective: string;
  primaryAction: Action;
  fallbackAction: Action;
  reasoning: string;
}

export interface RecoveryPlanContext {
  trigger: RecoveryPlanTrigger;
  rootCause: string;
  confidence: number;
  amountAtRisk: number;
  customerFailureCount: number;
  correlatedFailuresAtSameBank: number;
  automatedRetryCount: number;
  contactsLast24h: number;
  priorCustomerOutcomes: Array<{
    strategy: string | null;
    status: string;
    recoveredAmount: number;
  }>;
  strategyEvidence: StrategyEvidence[];
  previousPlan?: PersistedPlanSummary | null;
  observation?: Record<string, unknown> | null;
}

export interface RecoveryPlan {
  objective: string;
  primary_action: Action;
  fallback_action: Action;
  reasoning: string;
  escalation_criteria: string[];
  stop_conditions: string[];
}

const PLAN_TOOL = {
  type: "function" as const,
  function: {
    name: "submit_recovery_plan",
    description: "Submit a bounded recovery plan using only approved Recovery OS actions.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string" },
        primary_action: { type: "string", enum: [...ALLOWED_ACTIONS] },
        fallback_action: { type: "string", enum: [...ALLOWED_ACTIONS] },
        reasoning: { type: "string" },
        escalation_criteria: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
        stop_conditions: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
      },
      required: [
        "objective",
        "primary_action",
        "fallback_action",
        "reasoning",
        "escalation_criteria",
        "stop_conditions",
      ],
      additionalProperties: false,
    },
  },
};

function cleanStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Model returned invalid ${field}`);
  }
  return value.map((item) => String(item).trim());
}

export function parseRecoveryPlan(argumentsJson: string): RecoveryPlan {
  let parsed: any;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new Error("Model returned malformed JSON for recovery planning");
  }

  if (!ALLOWED_ACTIONS.includes(parsed?.primary_action)) {
    throw new Error(`Model returned unsupported primary action: ${String(parsed?.primary_action)}`);
  }
  if (!ALLOWED_ACTIONS.includes(parsed?.fallback_action)) {
    throw new Error(`Model returned unsupported fallback action: ${String(parsed?.fallback_action)}`);
  }
  if (typeof parsed?.objective !== "string" || parsed.objective.trim().length === 0) {
    throw new Error("Model returned an empty recovery objective");
  }
  if (typeof parsed?.reasoning !== "string" || parsed.reasoning.trim().length === 0) {
    throw new Error("Model returned an empty recovery-plan rationale");
  }

  return {
    objective: parsed.objective.trim(),
    primary_action: parsed.primary_action,
    fallback_action: parsed.fallback_action,
    reasoning: parsed.reasoning.trim(),
    escalation_criteria: cleanStringArray(parsed.escalation_criteria, "escalation criteria"),
    stop_conditions: cleanStringArray(parsed.stop_conditions, "stop conditions"),
  };
}

function describeStrategyEvidence(items: StrategyEvidence[]): string {
  if (items.length === 0) return "No comparable terminal recovery history yet.";
  return items
    .map((item) => `${item.strategy}: ${item.recoveries}/${item.cases} recovered (${item.recoveryRate.toFixed(1)}%), recovered ${item.recoveredAmount} paise`)
    .join("; ");
}

export function buildRecoveryPlannerPrompt(context: RecoveryPlanContext): string {
  const priorCustomerOutcomes = context.priorCustomerOutcomes.length
    ? context.priorCustomerOutcomes
        .map((item) => `${item.strategy ?? "unknown"}: ${item.status}, recovered ${item.recoveredAmount} paise`)
        .join("; ")
    : "none";
  const previous = context.previousPlan
    ? `v${context.previousPlan.version} (${context.previousPlan.trigger}): primary=${context.previousPlan.primaryAction}, fallback=${context.previousPlan.fallbackAction}; ${context.previousPlan.reasoning}`
    : "none";
  const observation = context.observation ? JSON.stringify(context.observation) : "none";

  return `You are the bounded recovery planner for Recovery OS. Your job is to create a business recovery plan, not to bypass safety controls.

Trigger: ${context.trigger}
Current diagnosis:
- root cause: ${context.rootCause}
- confidence: ${context.confidence}
- amount at risk: ${context.amountAtRisk} paise
- customer's earlier failed payments: ${context.customerFailureCount}
- earlier same-bank failures in the evidence window: ${context.correlatedFailuresAtSameBank}

Current deterministic-policy context:
- automated retry attempts already made: ${context.automatedRetryCount}
- outbound recovery contacts in the last 24h: ${context.contactsLast24h}

Previous customer outcomes: ${priorCustomerOutcomes}
Comparable strategy outcomes: ${describeStrategyEvidence(context.strategyEvidence)}
Previous recovery plan: ${previous}
New business observation: ${observation}

Rules:
- Choose only from the approved actions exposed by the tool.
- Build a plan with one primary action and one fallback action. The deterministic policy gate remains authoritative after this recommendation.
- Treat provider/network details such as HTTP 429, 5xx, Retry-After, database errors, or transport failures as infrastructure concerns. Do NOT use them as reasons for AI business replanning; deterministic execution code handles them.
- Replanning is for business outcomes: an earlier intervention remained unresolved, the customer replied with new intent, a Promise-to-Pay became due and remains unpaid, or equivalent customer/payment evidence changed.
- For intervention_unresolved, explicitly consider whether repeating the same primary strategy is justified. Prefer a different strategy when the prior strategy produced no business outcome and the context supports a safe alternative.
- For ambiguous or low-confidence cases, prefer escalation over confident automated action.
- Historical outcomes are evidence, not guarantees. Do not invent recovery rates or claim that simulated data is real revenue.
- Stop conditions must always include trusted payment success and original-payment success/customer opt-out in plain language.

Call submit_recovery_plan with the bounded plan.`;
}

export async function planRecovery(context: RecoveryPlanContext): Promise<RecoveryPlan> {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing from .env");
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [{ role: "user", content: buildRecoveryPlannerPrompt(context) }],
    tools: [PLAN_TOOL],
    tool_choice: { type: "function", function: { name: "submit_recovery_plan" } },
  });
  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Model did not return a recovery-plan tool call");
  return parseRecoveryPlan(toolCall.function.arguments);
}
