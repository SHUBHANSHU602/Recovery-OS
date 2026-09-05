import "dotenv/config";
import { Pool } from "pg";
import { logAuditEvent } from "../ledger/auditLog";
import { startOutboundRecoveryMessage } from "../agent/conversationalAgent";
import { recordOutboundContact, requestPaymentLink } from "./actionService";
import { scheduleBackoffRetry } from "./scheduledActions";
import { scheduleBusinessOutcomeReview } from "../recovery/replanQueue";
import { createHumanEscalation, ensureRecoveryCase, ensureTrack3Schema, setRecoveryState } from "../recovery/recoveryStore";
import { getChannelProviderStatus, sendRecoveryChannel, type RecoveryChannel } from "../channels/channelService";

const pool = new Pool();

interface ExecutionContext {
  eventId: string;
  interventionId: number;
  finalAction: string;
  amount: number;
  customerEmail: string;
  automatedRetryCount?: number;
}

const OPENING_MESSAGES: Record<string, string> = {
  whatsapp_nudge: "Hi! We noticed your recent payment didn't go through. Would you like a fresh payment link to try again?",
  offer_alternate_payment_method: "Hi! Your payment could not be completed. Would you like to try a different payment method?",
};

async function scheduleReview(context: ExecutionContext, action: string): Promise<void> {
  const caseId = await ensureRecoveryCase(pool, context.eventId);
  if (!caseId) return;
  await scheduleBusinessOutcomeReview(pool, {
    caseId,
    eventId: context.eventId,
    interventionId: context.interventionId,
    action,
  });
  await logAuditEvent(context.eventId, "business_outcome_review_scheduled", {
    interventionId: context.interventionId,
    action,
  });
}

async function executeAutomatedContact(context: ExecutionContext): Promise<void> {
  const caseId = await ensureRecoveryCase(pool, context.eventId);
  if (!caseId) throw new Error(`Unable to create recovery case for ${context.eventId}`);

  const action = context.finalAction as "whatsapp_nudge" | "offer_alternate_payment_method";
  const opening = OPENING_MESSAGES[action];
  const channel: RecoveryChannel = action === "whatsapp_nudge" ? "whatsapp" : "email";
  const provider = getChannelProviderStatus().find((item) => item.channel === channel);

  if (provider?.live) {
    try {
      const delivery = await sendRecoveryChannel(pool, { caseId, channel, message: opening });
      await logAuditEvent(context.eventId, "automated_recovery_channel_sent", {
        interventionId: context.interventionId,
        action,
        channel,
        provider: delivery.provider,
        live: delivery.live,
        deliveryStatus: delivery.status,
        providerMessageId: delivery.providerMessageId,
      });
      await startOutboundRecoveryMessage(context.eventId, context.customerEmail, context.amount, opening);
      await scheduleReview(context, action);
      return;
    } catch (error: any) {
      await createHumanEscalation(pool, caseId, context.eventId, `Live ${channel} delivery failed: ${error.message}`);
      await logAuditEvent(context.eventId, "automated_recovery_channel_failed", {
        interventionId: context.interventionId,
        action,
        channel,
        provider: provider.provider,
        error: error.message,
      });
      return;
    }
  }

  // Explicit fallback for development/test environments with no live provider
  // credentials. This remains visible as simulation rather than pretending a
  // Twilio/Resend delivery occurred.
  const result = await recordOutboundContact(context.eventId, action, opening);
  if (result.status === "executed") {
    await startOutboundRecoveryMessage(context.eventId, context.customerEmail, context.amount, opening);
    await scheduleReview(context, action);
  }
  await logAuditEvent(context.eventId, "automated_recovery_channel_simulated", {
    interventionId: context.interventionId,
    action,
    channel,
    result,
    providerReason: provider?.reason ?? "provider unavailable",
  });
}

export async function executeAction(context: ExecutionContext): Promise<void> {
  await ensureTrack3Schema(pool);

  if (context.finalAction === "stop") {
    const caseId = await ensureRecoveryCase(pool, context.eventId);
    if (caseId) await setRecoveryState(pool, caseId, "STOPPED", { terminalReason: "policy_stopped" });
    await logAuditEvent(context.eventId, "execution_stopped", { interventionId: context.interventionId });
    return;
  }

  if (context.finalAction === "retry_now" || context.finalAction === "issue_recovery_payment_link") {
    const attemptNumber = Math.max(1, Math.floor((context.automatedRetryCount ?? 0) + 1));
    const result = await requestPaymentLink(
      context.eventId,
      "retry_now",
      context.interventionId,
      `${context.eventId}_issue_recovery_payment_link_attempt_${attemptNumber}`
    );
    if (result.status === "executed") await scheduleReview(context, "issue_recovery_payment_link");
    await logAuditEvent(context.eventId, "execution_result", {
      interventionId: context.interventionId,
      finalAction: "issue_recovery_payment_link",
      attemptNumber,
      result,
    });
    return;
  }

  if (context.finalAction === "retry_with_backoff" || context.finalAction === "issue_recovery_payment_link_after_backoff") {
    await scheduleBackoffRetry(context.eventId, context.interventionId);
    await logAuditEvent(context.eventId, "execution_scheduled", {
      interventionId: context.interventionId,
      finalAction: "issue_recovery_payment_link_after_backoff",
    });
    return;
  }

  if (context.finalAction === "whatsapp_nudge" || context.finalAction === "offer_alternate_payment_method") {
    await executeAutomatedContact(context);
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
