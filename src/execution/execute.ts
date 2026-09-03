import "dotenv/config";
import { Pool } from "pg";
import { logAuditEvent } from "../ledger/auditLog";
import { startOutboundRecoveryMessage } from "../agent/conversationalAgent";
import { recordOutboundContact, requestPaymentLink } from "./actionService";
import { scheduleBackoffRetry } from "./scheduledActions";
import { createHumanEscalation, ensureRecoveryCase, ensureTrack3Schema, setRecoveryState } from "../recovery/recoveryStore";

const pool = new Pool();

interface ExecutionContext {
  eventId: string;
  interventionId: number;
  finalAction: string;
  amount: number;
  customerEmail: string;
}

const OPENING_MESSAGES: Record<string, string> = {
  whatsapp_nudge: "Hi! We noticed your recent payment didn't go through. Would you like a fresh payment link to try again?",
  offer_alternate_payment_method: "Hi! Your payment could not be completed. Would you like to try a different payment method?",
};

export async function executeAction(context: ExecutionContext): Promise<void> {
  await ensureTrack3Schema(pool);

  if (context.finalAction === "stop") {
    const caseId = await ensureRecoveryCase(pool, context.eventId);
    if (caseId) await setRecoveryState(pool, caseId, "STOPPED", { terminalReason: "policy_stopped" });
    await logAuditEvent(context.eventId, "execution_stopped", { interventionId: context.interventionId });
    return;
  }

  if (context.finalAction === "retry_now") {
    const result = await requestPaymentLink(
      context.eventId,
      "retry_now",
      context.interventionId,
      `${context.eventId}_retry_now_attempt_1`
    );
    await logAuditEvent(context.eventId, "execution_result", {
      interventionId: context.interventionId,
      finalAction: context.finalAction,
      result,
    });
    return;
  }

  if (context.finalAction === "retry_with_backoff") {
    await scheduleBackoffRetry(context.eventId, context.interventionId);
    await logAuditEvent(context.eventId, "execution_scheduled", {
      interventionId: context.interventionId,
      finalAction: context.finalAction,
    });
    return;
  }

  if (context.finalAction === "whatsapp_nudge" || context.finalAction === "offer_alternate_payment_method") {
    const opening = OPENING_MESSAGES[context.finalAction];
    const result = await recordOutboundContact(context.eventId, context.finalAction, opening);
    if (result.status === "executed") {
      await startOutboundRecoveryMessage(context.eventId, context.customerEmail, context.amount, opening);
    }
    await logAuditEvent(context.eventId, "execution_conversation_started", {
      interventionId: context.interventionId,
      finalAction: context.finalAction,
      result,
      direction: "assistant_outbound",
    });
    return;
  }

  if (context.finalAction === "escalate_to_human") {
    const caseId = await ensureRecoveryCase(pool, context.eventId);
    if (caseId) await createHumanEscalation(pool, caseId, context.eventId, "policy_or_agent_escalation");
    await logAuditEvent(context.eventId, "execution_requires_human", {
      interventionId: context.interventionId,
      finalAction: context.finalAction,
    });
    return;
  }

  throw new Error(`Unsupported final action: ${context.finalAction}`);
}
