import type { Action } from "./chooseAction";

export type ExecutableAction = Action | "stop";

export interface PolicyContext {
  chosenAction: Action;
  automatedRetryCount?: number;
  contactsLast24h?: number;
  alreadyRecovered?: boolean;
  optedOut?: boolean;
  // Backward-compatible inputs for the existing isolated policy tests.
  customerFailureCount?: number;
  customerContactedInLast24h?: boolean;
}

export interface PolicyOutcome {
  result: "APPROVED" | "BLOCKED_ESCALATED" | "BLOCKED_STOPPED";
  reason: string;
  finalAction: ExecutableAction;
}

const MAX_AUTOMATED_RETRIES = 3;
const MAX_CONTACTS_PER_DAY = 1;

export function applyPolicyGate(context: PolicyContext): PolicyOutcome {
  const automatedRetryCount = context.automatedRetryCount ?? context.customerFailureCount ?? 0;
  const contactsLast24h = context.contactsLast24h ?? (context.customerContactedInLast24h ? 1 : 0);

  if (context.alreadyRecovered) {
    return {
      result: "BLOCKED_STOPPED",
      reason: "Recovery case is already recovered. No further automated side effect is allowed.",
      finalAction: "stop",
    };
  }

  if (context.optedOut) {
    return {
      result: "BLOCKED_STOPPED",
      reason: "Customer has opted out of automated recovery contact.",
      finalAction: "stop",
    };
  }

  if (
    (context.chosenAction === "retry_now" || context.chosenAction === "retry_with_backoff") &&
    automatedRetryCount >= MAX_AUTOMATED_RETRIES
  ) {
    return {
      result: "BLOCKED_ESCALATED",
      reason: `Recovery case already has ${automatedRetryCount} automated retry attempts; maximum is ${MAX_AUTOMATED_RETRIES}. Escalating instead of executing again.`,
      finalAction: "escalate_to_human",
    };
  }

  if (
    (context.chosenAction === "whatsapp_nudge" || context.chosenAction === "offer_alternate_payment_method") &&
    contactsLast24h >= MAX_CONTACTS_PER_DAY
  ) {
    return {
      result: "BLOCKED_ESCALATED",
      reason: `Customer already has ${contactsLast24h} outbound recovery contact(s) in the last 24 hours. Blocking another contact and escalating.`,
      finalAction: "escalate_to_human",
    };
  }

  return {
    result: "APPROVED",
    reason: "Chosen action is within deterministic policy limits.",
    finalAction: context.chosenAction,
  };
}
