import "dotenv/config";
import Groq from "groq-sdk";
import { CANONICAL_ACTIONS, canonicalizeAction, type Action, type CanonicalAction } from "../policy/chooseAction";

const ALLOWED_ACTIONS: CanonicalAction[] = [...CANONICAL_ACTIONS];

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
  priorCustomerOutcomes: Array<{ strategy: string | null; status: string; recoveredAmount: number }>;
  strategyEvidence: StrategyEvidence[];
  previousPlan?: PersistedPlanSummary | null;
  observation?: Record<string, unknown> | null;
}

export interface RecoveryPlan {
  objective: string;
  primary_action: CanonicalAction;
  fallback_action: CanonicalAction;
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
      required: ["objective", "primary_action", "fallback_action", "reasoning", "escalation_criteria", "stop_conditions"],
      additionalProperties: false,
    },
  },
};

function cleanStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) throw new Error(`Model returned invalid ${field}`);
  return value.map((item) => String(item).trim());
}

export function parseRecoveryPlan(argumentsJson: string): RecoveryPlan {
  let parsed: any;
  try { parsed = JSON.parse(argumentsJson); } catch { throw new Error("Model returned malformed JSON for recovery planning"); }
  if (!ALLOWED_ACTIONS.includes(parsed?.primary_action)) throw new Error(`Model returned unsupported primary action: ${String(parsed?.primary_action)}`);
  if (!ALLOWED_ACTIONS.includes(parsed?.fallback_action)) throw new Error(`Model returned unsupported fallback action: ${String(parsed?.fallback_action)}`);
  if (typeof parsed?.objective !== "string" || parsed.objective.trim().length === 0) throw new Error("Model returned an empty recovery objective");
  if (typeof parsed?.reasoning !== "string" || parsed.reasoning.trim().length === 0) throw new Error("Model returned an empty recovery-plan rationale");
  return {
    objective: parsed.objective.trim(), primary_action: parsed.primary_action, fallback_action: parsed.fallback_action,
    reasoning: parsed.reasoning.trim(), escalation_criteria: cleanStringArray(parsed.escalation_criteria, "escalation criteria"),
    stop_conditions: cleanStringArray(parsed.stop_conditions, "stop conditions"),
  };
}

function canonicalStrategy(value: string): string {
  if (value === "retry_now") return "issue_recovery_payment_link";
  if (value === "retry_with_backoff") return "issue_recovery_payment_link_after_backoff";
  return value;
}

function describeStrategyEvidence(items: StrategyEvidence[]): string {
  if (items.length === 0) return "No comparable terminal recovery history yet.";
  return items.map((item) => `${canonicalStrategy(item.strategy)}: ${item.recoveries}/${item.cases} recovered (${item.recoveryRate.toFixed(1)}%), recovered ${item.recoveredAmount} paise`).join("; ");
}

function strategyEvidenceFor(context: RecoveryPlanContext, strategy: CanonicalAction): StrategyEvidence | undefined {
  return context.strategyEvidence.find((item) => canonicalStrategy(item.strategy) === strategy);
}

function priorAction(context: RecoveryPlanContext): string | null {
  const value = context.observation?.priorAction;
  const raw = typeof value === "string" ? value : context.previousPlan?.primaryAction ?? null;
  return raw ? canonicalStrategy(String(raw)) : null;
}

export function applyPlannerBusinessGuardrails(context: RecoveryPlanContext, modelPlan: RecoveryPlan): RecoveryPlan {
  let primary: CanonicalAction = modelPlan.primary_action;
  let fallback: CanonicalAction = modelPlan.fallback_action;
  let guardrailReason: string | null = null;
  const prior = priorAction(context);

  if (context.rootCause === "ambiguous" || context.confidence < 0.5) {
    primary = "escalate_to_human"; fallback = "escalate_to_human";
    guardrailReason = "Low-confidence or ambiguous evidence requires abstention rather than confident automation.";
  } else if (context.automatedRetryCount >= 3) {
    primary = "escalate_to_human"; fallback = "escalate_to_human";
    guardrailReason = "The bounded recovery-link issuance budget is exhausted, so recovery must move to human review.";
  } else if (context.contactsLast24h >= 1 && (context.trigger === "promise_due_unpaid" || (context.trigger === "intervention_unresolved" && ["whatsapp_nudge", "offer_alternate_payment_method"].includes(prior ?? "")))) {
    primary = "escalate_to_human"; fallback = "escalate_to_human";
    guardrailReason = "The current business outcome would require more customer recovery contact, but today's automated contact budget is already consumed.";
  } else if (context.trigger === "initial_failure") {
    if (context.rootCause === "systemic_bank_outage" && context.correlatedFailuresAtSameBank >= 2) {
      primary = "issue_recovery_payment_link_after_backoff"; fallback = "escalate_to_human";
      guardrailReason = "Correlated bank failures favor waiting before issuing or reusing a customer-authorized recovery Payment Link.";
    } else if (context.rootCause === "expired_card") {
      primary = "offer_alternate_payment_method"; fallback = "escalate_to_human";
      guardrailReason = "An expired instrument should move the customer to a different payment method rather than repeat the same path.";
    } else if (context.rootCause === "insufficient_funds") {
      primary = "whatsapp_nudge"; fallback = "issue_recovery_payment_link_after_backoff";
      guardrailReason = "A first insufficient-funds failure supports one bounded customer nudge before delayed recovery-link fallback.";
    }
  } else if (context.trigger === "promise_due_unpaid" && context.rootCause === "insufficient_funds") {
    primary = "whatsapp_nudge"; fallback = "escalate_to_human";
    guardrailReason = "A due unpaid promise is new customer evidence that supports one compliant reminder when contact capacity remains.";
  } else if (context.trigger === "intervention_unresolved") {
    if (context.rootCause === "expired_card" && prior === "offer_alternate_payment_method" && context.customerFailureCount >= 3) {
      primary = "escalate_to_human"; fallback = "escalate_to_human";
      guardrailReason = "Repeated unresolved alternate-method recovery should not be replaced by another unsolicited automated strategy.";
    } else if (context.rootCause === "insufficient_funds" && prior === "whatsapp_nudge") {
      const nudge = strategyEvidenceFor(context, "whatsapp_nudge");
      const retry = strategyEvidenceFor(context, "issue_recovery_payment_link_after_backoff");
      if (nudge && retry && retry.cases >= 3 && retry.recoveryRate >= nudge.recoveryRate + 15) {
        primary = "issue_recovery_payment_link_after_backoff"; fallback = "escalate_to_human";
        guardrailReason = "The prior nudge remained unresolved and delayed recovery-link history is materially stronger, so the replan changes strategy.";
      }
    } else if (context.rootCause === "systemic_bank_outage" && prior === "issue_recovery_payment_link_after_backoff") {
      const retry = strategyEvidenceFor(context, "issue_recovery_payment_link_after_backoff");
      if (retry && retry.cases >= 5 && retry.recoveryRate <= 20) {
        primary = "escalate_to_human"; fallback = "escalate_to_human";
        guardrailReason = "The delayed recovery-link strategy remained unresolved and comparable outcomes are consistently poor, so the system stops repeating it.";
      }
    }
  }

  if (!guardrailReason || (primary === modelPlan.primary_action && fallback === modelPlan.fallback_action)) return modelPlan;
  return { ...modelPlan, primary_action: primary, fallback_action: fallback, reasoning: `${modelPlan.reasoning} Deterministic business guardrail: ${guardrailReason}` };
}

export function buildRecoveryPlannerPrompt(context: RecoveryPlanContext): string {
  const priorCustomerOutcomes = context.priorCustomerOutcomes.length ? context.priorCustomerOutcomes.map((item) => `${canonicalStrategy(item.strategy ?? "unknown")}: ${item.status}, recovered ${item.recoveredAmount} paise`).join("; ") : "none";
  const previous = context.previousPlan ? `v${context.previousPlan.version} (${context.previousPlan.trigger}): primary=${canonicalStrategy(String(context.previousPlan.primaryAction))}, fallback=${canonicalStrategy(String(context.previousPlan.fallbackAction))}; ${context.previousPlan.reasoning}` : "none";
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
- automated recovery-link attempts already made: ${context.automatedRetryCount}
- outbound recovery contacts in the last 24h: ${context.contactsLast24h}

Previous customer outcomes: ${priorCustomerOutcomes}
Comparable strategy outcomes: ${describeStrategyEvidence(context.strategyEvidence)}
Previous recovery plan: ${previous}
New business observation: ${observation}

Payment semantics:
- issue_recovery_payment_link creates or reuses a Razorpay Payment Link that requires fresh customer authorization. It never retries the original charge.
- issue_recovery_payment_link_after_backoff delays that recovery-link flow. It never auto-charges the original payment.

Decision priorities:
- Low-confidence or ambiguous evidence should abstain to human review.
- Do not route around exhausted recovery-link or contact budgets.
- On an initial high-confidence failure: correlated bank outage -> delayed recovery-link issuance; expired instrument -> alternate payment method; insufficient funds -> one bounded customer nudge.
- On replan, prior unresolved outcomes and comparable strategy evidence can justify changing away from the initial default.
- A due unpaid Promise-to-Pay is new customer evidence; use a compliant reminder only if contact capacity remains.

Rules:
- Choose only from the approved actions exposed by the tool.
- Deterministic business guardrails and the deterministic policy gate remain authoritative after this recommendation.
- Treat HTTP 429, 5xx, Retry-After, database errors, or transport failures as infrastructure concerns handled by deterministic execution code.
- Replanning is for business outcomes, not transport failures.
- Historical outcomes are evidence, not guarantees. Do not invent recovery rates or claim simulated data is real revenue.
- Stop conditions must include trusted payment success and original-payment success/customer opt-out.

Call submit_recovery_plan with the bounded plan.`;
}

export async function planRecovery(context: RecoveryPlanContext): Promise<RecoveryPlan> {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing from .env");
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const response = await groq.chat.completions.create({ model: "openai/gpt-oss-120b", temperature: 0, messages: [{ role: "user", content: buildRecoveryPlannerPrompt(context) }], tools: [PLAN_TOOL], tool_choice: { type: "function", function: { name: "submit_recovery_plan" } } });
  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Model did not return a recovery-plan tool call");
  return applyPlannerBusinessGuardrails(context, parseRecoveryPlan(toolCall.function.arguments));
}
