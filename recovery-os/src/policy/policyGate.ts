import type { Action } from "./chooseAction";

interface PolicyContext {
  chosenAction: Action;
  customerFailureCount: number; // total prior failures for this customer
  customerContactedInLast24h: boolean; // has this customer already gotten a whatsapp_nudge today
}

interface PolicyOutcome {
  result: "APPROVED" | "BLOCKED_ESCALATED";
  reason: string;
  finalAction: Action;
}

const MAX_AUTOMATED_RETRIES = 3;
const MAX_CONTACTS_PER_DAY = 1;

export function applyPolicyGate(context: PolicyContext): PolicyOutcome {
  // Hard cap: too many prior failures -> force human escalation regardless of what the LLM wanted
  if (
    (context.chosenAction === "retry_now" || context.chosenAction === "retry_with_backoff") &&
    context.customerFailureCount >= MAX_AUTOMATED_RETRIES
  ) {
    return {
      result: "BLOCKED_ESCALATED",
      reason: `Customer has ${context.customerFailureCount} prior failures, exceeding the max of ${MAX_AUTOMATED_RETRIES} automated retries. Forcing escalation instead of another automated attempt.`,
      finalAction: "escalate_to_human",
    };
  }

  // Contact cap: don't spam a customer who's already been reached out to today
  if (context.chosenAction === "whatsapp_nudge" && context.customerContactedInLast24h) {
    return {
      result: "BLOCKED_ESCALATED",
      reason: `Customer already contacted via WhatsApp in the last 24 hours. Blocking a second contact attempt to avoid spamming; escalating instead.`,
      finalAction: "escalate_to_human",
    };
  }

  return {
    result: "APPROVED",
    reason: "Chosen action is within policy limits.",
    finalAction: context.chosenAction,
  };
}