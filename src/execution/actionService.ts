import "dotenv/config";
import { Pool } from "pg";
import type { Action } from "../policy/chooseAction";
import { applyPolicyGate } from "../policy/policyGate";
import { loadPolicyContext } from "../policy/policyContext";
import { createHumanEscalation, ensureRecoveryCase, ensureTrack3Schema, isRecoveryTerminal, setRecoveryState } from "../recovery/recoveryStore";
import { logAuditEvent } from "../ledger/auditLog";
import { isQuietHours, nextAllowedContactTime } from "../intelligence/recoveryIntelligence";

const pool = new Pool();

export interface ActionServiceResult {
  status: "executed" | "duplicate" | "blocked" | "failed" | "escalated" | "deferred";
  reason?: string;
  shortUrl?: string | null;
  razorpayStatus?: number;
  retryAfterSeconds?: number | null;
  deferredUntil?: string | null;
}

async function trustedEventContext(eventId: string) {
  const result = await pool.query("SELECT payload FROM events WHERE event_id = $1", [eventId]);
  if (result.rows.length === 0) throw new Error(`Unknown event ${eventId}`);
  const payment = result.rows[0].payload?.payload?.payment?.entity;
  if (!payment) throw new Error(`Event ${eventId} has no payment entity`);
  return { customerEmail: String(payment.email ?? ""), amount: Number(payment.amount ?? 0) };
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.ceil((when - Date.now()) / 1000));
}

export async function requestPaymentLink(
  eventId: string,
  desiredAction: Action,
  interventionId: number | null = null,
  executionKey?: string
): Promise<ActionServiceResult> {
  await ensureTrack3Schema(pool);
  const trusted = await trustedEventContext(eventId);
  const caseId = await ensureRecoveryCase(pool, eventId);
  if (!caseId) throw new Error(`Unable to create recovery case for ${eventId}`);

  if (await isRecoveryTerminal(pool, eventId)) {
    return { status: "blocked", reason: "Recovery case is terminal." };
  }

  const policyContext = await loadPolicyContext(pool, { eventId, customerEmail: trusted.customerEmail });
  const policy = applyPolicyGate({ chosenAction: desiredAction, ...policyContext });
  await logAuditEvent(eventId, "action_service_policy", { desiredAction, policyContext, policy, executionKey });
  if (policy.result !== "APPROVED") {
    if (policy.finalAction === "stop") {
      await setRecoveryState(pool, caseId, "STOPPED", { terminalReason: policy.reason });
    } else {
      await createHumanEscalation(pool, caseId, eventId, policy.reason);
    }
    return { status: "blocked", reason: policy.reason };
  }

  const idempotencyKey = executionKey ?? `${eventId}_${desiredAction}_attempt_1`;
  const claim = await pool.query(
    `INSERT INTO actions (intervention_id, razorpay_api_call, idempotency_key, status, response)
     VALUES ($1, 'payment_links.create', $2, 'pending', '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [interventionId, idempotencyKey]
  );

  if (claim.rows.length === 0) {
    const existing = await pool.query("SELECT status, response FROM actions WHERE idempotency_key = $1", [idempotencyKey]);
    return {
      status: "duplicate",
      reason: `Action attempt already claimed (${existing.rows[0]?.status ?? "unknown"}).`,
      shortUrl: existing.rows[0]?.response?.short_url ?? null,
    };
  }

  const actionId = claim.rows[0].id;
  try {
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
    const response = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: trusted.amount,
        currency: "INR",
        description: `Recovery OS — ${eventId}`,
        reference_id: `recovery_case_${caseId}`,
        notify: { sms: false, email: false },
      }),
    });
    const raw = await response.text();
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { raw };
    }
    const success = response.ok;
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
    await pool.query("UPDATE actions SET status = $2, response = $3 WHERE id = $1", [
      actionId,
      success ? "success" : "failed",
      JSON.stringify({ ...body, retryAfterSeconds }),
    ]);

    if (success && body.id) {
      await pool.query(
        `UPDATE recovery_cases
         SET razorpay_payment_link_id = $2, strategy = $3, status = 'WAITING_FOR_OUTCOME', updated_at = now()
         WHERE id = $1`,
        [caseId, body.id, desiredAction]
      );
    }
    await logAuditEvent(eventId, "action_service_execution", {
      desiredAction,
      executionKey: idempotencyKey,
      actionId,
      razorpayStatus: response.status,
      retryAfterSeconds,
      paymentLinkId: body.id ?? null,
    });
    return {
      status: success ? "executed" : "failed",
      shortUrl: body.short_url ?? null,
      razorpayStatus: response.status,
      retryAfterSeconds,
      reason: success ? undefined : (body?.error?.description ?? body?.error?.reason ?? `Razorpay returned HTTP ${response.status}`),
    };
  } catch (error: any) {
    await pool.query("UPDATE actions SET status = 'error', response = $2 WHERE id = $1", [
      actionId,
      JSON.stringify({ error: error.message }),
    ]);
    await logAuditEvent(eventId, "action_service_error", { desiredAction, executionKey: idempotencyKey, actionId, error: error.message });
    return { status: "failed", reason: error.message };
  }
}

export async function recordOutboundContact(
  eventId: string,
  desiredAction: Extract<Action, "whatsapp_nudge" | "offer_alternate_payment_method">,
  openingMessage: string,
  options: { executionKey?: string; purpose?: string; now?: Date; deferDuringQuietHours?: boolean } = {}
): Promise<ActionServiceResult> {
  await ensureTrack3Schema(pool);
  const trusted = await trustedEventContext(eventId);
  const caseId = await ensureRecoveryCase(pool, eventId);
  if (!caseId) throw new Error(`Unable to create recovery case for ${eventId}`);
  if (await isRecoveryTerminal(pool, eventId)) return { status: "blocked", reason: "Recovery case is terminal." };

  const policyContext = await loadPolicyContext(pool, { eventId, customerEmail: trusted.customerEmail });
  const policy = applyPolicyGate({ chosenAction: desiredAction, ...policyContext });
  await logAuditEvent(eventId, "action_service_policy", { desiredAction, policyContext, policy });
  if (policy.result !== "APPROVED") {
    if (policy.finalAction === "stop") await setRecoveryState(pool, caseId, "STOPPED", { terminalReason: policy.reason });
    else await createHumanEscalation(pool, caseId, eventId, policy.reason);
    return { status: "blocked", reason: policy.reason };
  }

  const now = options.now ?? new Date();
  if (options.deferDuringQuietHours !== false && isQuietHours(now)) {
    const runAt = nextAllowedContactTime(now);
    const scheduleKey = options.executionKey ?? `${eventId}_${desiredAction}_quiet_hours_${runAt.getTime()}`;
    await pool.query(
      `INSERT INTO scheduled_actions
         (case_id, event_id, intervention_id, desired_action, schedule_key, run_at, status)
       VALUES ($1, $2, NULL, $3, $4, $5, 'PENDING')
       ON CONFLICT (schedule_key) DO NOTHING`,
      [caseId, eventId, `contact:${desiredAction}`, scheduleKey, runAt]
    );
    await setRecoveryState(pool, caseId, "SCHEDULED", { strategy: desiredAction });
    await logAuditEvent(eventId, "contact_deferred_quiet_hours", {
      desiredAction,
      purpose: options.purpose ?? desiredAction,
      deferredUntil: runAt.toISOString(),
    });
    return {
      status: "deferred",
      reason: "Outbound recovery contact deferred by quiet-hours policy.",
      deferredUntil: runAt.toISOString(),
    };
  }

  const idempotencyKey = options.executionKey ?? `${eventId}_${desiredAction}_contact_1`;
  const claim = await pool.query(
    `INSERT INTO actions (intervention_id, razorpay_api_call, idempotency_key, status, response)
     VALUES (NULL, 'outbound_contact', $1, 'pending', '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [idempotencyKey]
  );
  if (claim.rows.length === 0) return { status: "duplicate", reason: "Outbound contact already claimed." };

  await pool.query(
    `INSERT INTO outbound_contacts (case_id, customer_email, channel, purpose, delivery_state)
     VALUES ($1, $2, 'simulated', $3, 'accepted')`,
    [caseId, trusted.customerEmail, options.purpose ?? desiredAction]
  );
  await pool.query("UPDATE actions SET status = 'success', response = $2 WHERE id = $1", [
    claim.rows[0].id,
    JSON.stringify({ openingMessage, channel: "simulated", purpose: options.purpose ?? desiredAction }),
  ]);
  await setRecoveryState(pool, caseId, "WAITING_FOR_OUTCOME", { strategy: desiredAction });
  await logAuditEvent(eventId, "outbound_contact_recorded", {
    desiredAction,
    purpose: options.purpose ?? desiredAction,
    executionKey: idempotencyKey,
  });
  return { status: "executed" };
}
