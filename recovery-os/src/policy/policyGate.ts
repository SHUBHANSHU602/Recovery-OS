import type { Action } from "./chooseAction";

export type FinalAction = Action | "stop_recovery";

interface PolicyContext {
  chosenAction: Action;
  automatedRecoveryAttemptCount: number;
  customerContactedInLast24h: boolean;
  paymentAlreadyRecovered: boolean;
}

interface PolicyOutcome {
  result: "APPROVED" | "BLOCKED_ESCALATED" | "BLOCKED_STOPPED";
  reason: string;
  finalAction: FinalAction;
}

const MAX_AUTOMATED_PAYMENT_ATTEMPTS = 3;

export function applyPolicyGate(context: PolicyContext): PolicyOutcome {
  if (context.paymentAlreadyRecovered) {
    return {
      result: "BLOCKED_STOPPED",
      reason: "The original failed payment has already been recovered. No further recovery action is allowed.",
      finalAction: "stop_recovery",
    };
  }

  const createsAnotherPaymentAttempt =
    context.chosenAction === "retry_now" ||
    context.chosenAction === "retry_with_backoff" ||
    context.chosenAction === "offer_alternate_payment_method";

  if (createsAnotherPaymentAttempt && context.automatedRecoveryAttemptCount >= MAX_AUTOMATED_PAYMENT_ATTEMPTS) {
    return {
      result: "BLOCKED_ESCALATED",
      reason: `Customer already has ${context.automatedRecoveryAttemptCount} automated recovery payment attempt(s); the maximum is ${MAX_AUTOMATED_PAYMENT_ATTEMPTS}. Escalating instead of creating another payment request.`,
      finalAction: "escalate_to_human",
    };
  }

  if (context.chosenAction === "whatsapp_nudge" && context.customerContactedInLast24h) {
    return {
      result: "BLOCKED_ESCALATED",
      reason: "Customer was already contacted about a failed payment in the last 24 hours. Blocking another automated nudge to avoid repeated outreach.",
      finalAction: "escalate_to_human",
    };
  }

  return {
    result: "APPROVED",
    reason: "Chosen action is within recovery policy limits.",
    finalAction: context.chosenAction,
  };
}
