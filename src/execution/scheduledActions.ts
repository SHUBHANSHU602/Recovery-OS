import "dotenv/config";
import { Pool } from "pg";
import { recordOutboundContact, requestPaymentLink } from "./actionService";
import { createHumanEscalation, ensureTrack3Schema, isRecoveryTerminal, setRecoveryState } from "../recovery/recoveryStore";
import { logAuditEvent } from "../ledger/auditLog";
import { causeAwareInitialDelaySeconds } from "../intelligence/recoveryIntelligence";

const pool = new Pool();
const STALE_CLAIM_MINUTES = 5;
const MAX_SCHEDULED_ATTEMPTS = 3;
const BASE_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 30 * 60;

function deterministicJitterSeconds(caseId: number, attempt: number): number {
  return (caseId * 17 + attempt * 11) % 31;
}

function computeDelaySeconds(caseId: number, attempt: number, retryAfterSeconds?: number | null): number {
  if (retryAfterSeconds != null && retryAfterSeconds >= 0) return Math.min(MAX_DELAY_SECONDS, retryAfterSeconds);
  const exponential = BASE_DELAY_SECONDS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(MAX_DELAY_SECONDS, exponential + deterministicJitterSeconds(caseId, attempt));
}

async function nextAttemptNumber(caseId: number): Promise<number> {
  const existing = await pool.query(
    `SELECT COUNT(*) FROM scheduled_actions
     WHERE case_id = $1 AND desired_action = 'retry_with_backoff'`,
    [caseId]
  );
  return Number(existing.rows[0]?.count ?? 0) + 1;
}

async function initialDelayForEvent(eventId: string): Promise<{ delaySeconds: number; rootCause: string | null }> {
  const result = await pool.query(
    `SELECT root_cause
     FROM diagnoses
     WHERE event_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [eventId]
  );
  const rootCause = result.rows[0]?.root_cause == null ? null : String(result.rows[0].root_cause);
  return { delaySeconds: causeAwareInitialDelaySeconds(rootCause), rootCause };
}

export async function scheduleBackoffRetry(
  eventId: string,
  interventionId: number | null,
  requestedDelaySeconds?: number
): Promise<void> {
  await ensureTrack3Schema(pool);
  const caseResult = await pool.query("SELECT id FROM recovery_cases WHERE original_event_id = $1", [eventId]);
  if (caseResult.rows.length === 0) throw new Error(`Recovery case missing for ${eventId}`);
  const caseId = Number(caseResult.rows[0].id);
  if (await isRecoveryTerminal(pool, eventId)) return;

  const attemptNumber = await nextAttemptNumber(caseId);
  if (attemptNumber > MAX_SCHEDULED_ATTEMPTS) {
    const reason = `Maximum scheduled recovery attempts (${MAX_SCHEDULED_ATTEMPTS}) reached.`;
    await createHumanEscalation(pool, caseId, eventId, reason);
    await logAuditEvent(eventId, "scheduled_retry_exhausted", { attemptNumber, maxAttempts: MAX_SCHEDULED_ATTEMPTS });
    return;
  }

  const causeTiming = await initialDelayForEvent(eventId);
  const scheduleKey = `${eventId}_retry_with_backoff_attempt_${attemptNumber}`;
  const delaySeconds = Math.max(1, Math.floor(requestedDelaySeconds ?? causeTiming.delaySeconds));
  await pool.query(
    `INSERT INTO scheduled_actions
       (case_id, event_id, intervention_id, desired_action, schedule_key, run_at, status)
     VALUES ($1, $2, $3, 'retry_with_backoff', $4, now() + ($5 * interval '1 second'), 'PENDING')
     ON CONFLICT (schedule_key) DO NOTHING`,
    [caseId, eventId, interventionId, scheduleKey, delaySeconds]
  );
  await setRecoveryState(pool, caseId, "SCHEDULED", { strategy: "retry_with_backoff" });
  await logAuditEvent(eventId, "scheduled_retry_created", {
    scheduleKey,
    attemptNumber,
    delaySeconds,
    timingSource: requestedDelaySeconds == null ? "root_cause" : "explicit",
    rootCause: causeTiming.rootCause,
  });
}

async function processScheduledContact(job: any): Promise<void> {
  const desiredAction = String(job.desired_action).replace("contact:", "") as "whatsapp_nudge" | "offer_alternate_payment_method";
  const opening = desiredAction === "offer_alternate_payment_method"
    ? "Your previous payment could not be completed. You can continue with an alternate payment method when ready."
    : "Your previous payment could not be completed. You can retry securely when ready.";

  const result = await recordOutboundContact(String(job.event_id), desiredAction, opening, {
    executionKey: `${job.schedule_key}_contact`,
    purpose: desiredAction,
    deferDuringQuietHours: true,
  });

  await pool.query(
    "UPDATE scheduled_actions SET status = $2, last_error = $3, updated_at = now() WHERE id = $1",
    [job.id, result.status === "blocked" ? "CANCELLED" : "DONE", result.reason ?? null]
  );
  await logAuditEvent(String(job.event_id), "scheduled_contact_processed", { scheduleKey: job.schedule_key, result });
}

async function processPromiseReminder(job: any): Promise<void> {
  const promiseResult = await pool.query(
    `SELECT id, promised_amount, due_at
     FROM payment_promises
     WHERE case_id = $1 AND status = 'PENDING'
     ORDER BY due_at ASC
     LIMIT 1`,
    [job.case_id]
  );
  if (promiseResult.rows.length === 0) {
    await pool.query("UPDATE scheduled_actions SET status = 'CANCELLED', updated_at = now() WHERE id = $1", [job.id]);
    return;
  }

  const promise = promiseResult.rows[0];
  const message = `Reminder: your promised payment of ₹${(Number(promise.promised_amount) / 100).toFixed(2)} is due. You can complete it securely when ready.`;
  const result = await recordOutboundContact(String(job.event_id), "whatsapp_nudge", message, {
    executionKey: `${job.schedule_key}_contact`,
    purpose: "promise_to_pay_reminder",
    deferDuringQuietHours: true,
  });

  await pool.query(
    "UPDATE scheduled_actions SET status = $2, last_error = $3, updated_at = now() WHERE id = $1",
    [job.id, result.status === "blocked" ? "CANCELLED" : "DONE", result.reason ?? null]
  );
  await logAuditEvent(String(job.event_id), "promise_to_pay_reminder_processed", {
    promiseId: Number(promise.id),
    scheduleKey: job.schedule_key,
    result,
  });
}

export async function processDueScheduledActions(limit = 10): Promise<void> {
  await ensureTrack3Schema(pool);
  const due = await pool.query(
    `SELECT id
     FROM scheduled_actions
     WHERE (status = 'PENDING' AND run_at <= now())
        OR (status = 'RUNNING' AND claimed_at < now() - ($2 * interval '1 minute'))
     ORDER BY run_at ASC
     LIMIT $1`,
    [limit, STALE_CLAIM_MINUTES]
  );

  for (const row of due.rows) {
    const claim = await pool.query(
      `UPDATE scheduled_actions
       SET status = 'RUNNING', claimed_at = now(), attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = $1
         AND ((status = 'PENDING' AND run_at <= now())
           OR (status = 'RUNNING' AND claimed_at < now() - ($2 * interval '1 minute')))
       RETURNING id, case_id, event_id, intervention_id, desired_action, schedule_key, attempt_count`,
      [row.id, STALE_CLAIM_MINUTES]
    );
    if (claim.rows.length === 0) continue;

    const job = claim.rows[0];
    if (await isRecoveryTerminal(pool, String(job.event_id))) {
      await pool.query("UPDATE scheduled_actions SET status = 'CANCELLED', updated_at = now() WHERE id = $1", [job.id]);
      continue;
    }

    if (String(job.desired_action).startsWith("contact:")) {
      await processScheduledContact(job);
      continue;
    }
    if (String(job.desired_action) === "promise_to_pay_reminder") {
      await processPromiseReminder(job);
      continue;
    }
    if (String(job.desired_action) !== "retry_with_backoff") {
      await pool.query(
        "UPDATE scheduled_actions SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1",
        [job.id, `Unsupported scheduled action ${job.desired_action}`]
      );
      continue;
    }

    const result = await requestPaymentLink(
      String(job.event_id),
      "retry_with_backoff",
      job.intervention_id == null ? null : Number(job.intervention_id),
      String(job.schedule_key)
    );

    if (result.status === "executed" || result.status === "blocked") {
      await pool.query(
        "UPDATE scheduled_actions SET status = $2, last_error = NULL, updated_at = now() WHERE id = $1",
        [job.id, result.status === "blocked" ? "CANCELLED" : "DONE"]
      );
      continue;
    }

    if (result.status === "duplicate") {
      const reason = result.reason ?? "Scheduled action attempt was already claimed.";
      await pool.query(
        "UPDATE scheduled_actions SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1",
        [job.id, reason]
      );
      await createHumanEscalation(pool, Number(job.case_id), String(job.event_id), `Ambiguous prior execution state: ${reason}`);
      await logAuditEvent(String(job.event_id), "scheduled_retry_ambiguous_duplicate", { scheduleKey: job.schedule_key, reason });
      continue;
    }

    const transient = result.razorpayStatus === 429 || (result.razorpayStatus != null && result.razorpayStatus >= 500) || result.razorpayStatus == null;
    const nextAttempt = await nextAttemptNumber(Number(job.case_id));
    if (!transient || nextAttempt > MAX_SCHEDULED_ATTEMPTS) {
      const reason = transient
        ? `Scheduled retry exhausted after ${MAX_SCHEDULED_ATTEMPTS} execution attempts.`
        : `Scheduled retry failed with non-retryable Razorpay status ${result.razorpayStatus}.`;
      await pool.query(
        "UPDATE scheduled_actions SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1",
        [job.id, result.reason ?? reason]
      );
      await createHumanEscalation(pool, Number(job.case_id), String(job.event_id), reason);
      await logAuditEvent(String(job.event_id), "scheduled_retry_failed_terminally", { scheduleKey: job.schedule_key, result, reason });
      continue;
    }

    const delaySeconds = computeDelaySeconds(Number(job.case_id), nextAttempt, result.retryAfterSeconds);
    const nextKey = `${job.event_id}_retry_with_backoff_attempt_${nextAttempt}`;
    await pool.query(
      `INSERT INTO scheduled_actions
         (case_id, event_id, intervention_id, desired_action, schedule_key, run_at, status)
       VALUES ($1, $2, $3, 'retry_with_backoff', $4, now() + ($5 * interval '1 second'), 'PENDING')
       ON CONFLICT (schedule_key) DO NOTHING`,
      [job.case_id, job.event_id, job.intervention_id, nextKey, delaySeconds]
    );
    await pool.query(
      "UPDATE scheduled_actions SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1",
      [job.id, result.reason ?? "Transient execution failure"]
    );
    await logAuditEvent(String(job.event_id), "scheduled_retry_rescheduled", {
      previousKey: job.schedule_key,
      nextKey,
      delaySeconds,
      timingSource: result.retryAfterSeconds != null ? "provider_retry_after" : "execution_backoff",
      razorpayStatus: result.razorpayStatus,
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }
}
