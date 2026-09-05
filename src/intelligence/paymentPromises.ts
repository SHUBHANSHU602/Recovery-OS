import type { Pool } from "pg";
import { logAuditEvent } from "../ledger/auditLog";
import { ensureTrack3Schema, isRecoveryTerminal } from "../recovery/recoveryStore";
import { nextAllowedContactTime } from "./recoveryIntelligence";

export interface PromiseToPayInput {
  caseId: number;
  promisedAmount?: number | null;
  dueAt: Date;
  source?: string;
  note?: string | null;
}

export async function createPromiseToPay(pool: Pool, input: PromiseToPayInput) {
  await ensureTrack3Schema(pool);

  const caseResult = await pool.query(
    `SELECT original_event_id, amount_at_risk, recovered_amount, status
     FROM recovery_cases
     WHERE id = $1`,
    [input.caseId]
  );
  if (caseResult.rows.length === 0) throw new Error(`Recovery case ${input.caseId} does not exist`);

  const row = caseResult.rows[0];
  const eventId = String(row.original_event_id);
  if (await isRecoveryTerminal(pool, eventId)) throw new Error("Cannot create a promise for a terminal recovery case");
  if (!(input.dueAt instanceof Date) || Number.isNaN(input.dueAt.getTime()) || input.dueAt.getTime() <= Date.now()) {
    throw new Error("Promise due time must be in the future");
  }

  const outstanding = Math.max(0, Number(row.amount_at_risk ?? 0) - Number(row.recovered_amount ?? 0));
  if (outstanding <= 0) throw new Error("Recovery case has no outstanding amount to promise");
  const requestedAmount = Math.floor(input.promisedAmount ?? outstanding);
  if (requestedAmount <= 0) throw new Error("Promise amount must be positive");
  const promisedAmount = Math.min(outstanding, requestedAmount);

  const reminderAt = nextAllowedContactTime(input.dueAt);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replaced = await client.query(
      `UPDATE payment_promises
       SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
       WHERE case_id = $1 AND status = 'PENDING'
       RETURNING id`,
      [input.caseId]
    );

    if (replaced.rows.length > 0) {
      const staleReminderKeys = replaced.rows.map((item) => `${eventId}_promise_${Number(item.id)}_reminder`);
      await client.query(
        `UPDATE scheduled_actions
         SET status = 'CANCELLED', updated_at = now()
         WHERE schedule_key = ANY($1::text[])
           AND status = 'PENDING'`,
        [staleReminderKeys]
      );
    }

    const inserted = await client.query(
      `INSERT INTO payment_promises
         (case_id, event_id, promised_amount, due_at, status, source, note)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)
       RETURNING id, promised_amount, due_at, status, source, note, created_at`,
      [input.caseId, eventId, promisedAmount, input.dueAt, input.source ?? "merchant_or_agent", input.note ?? null]
    );

    const promiseId = Number(inserted.rows[0].id);
    const scheduleKey = `${eventId}_promise_${promiseId}_reminder`;
    await client.query(
      `INSERT INTO scheduled_actions
         (case_id, event_id, intervention_id, desired_action, schedule_key, run_at, status)
       VALUES ($1, $2, NULL, 'promise_to_pay_reminder', $3, $4, 'PENDING')
       ON CONFLICT (schedule_key) DO NOTHING`,
      [input.caseId, eventId, scheduleKey, reminderAt]
    );
    await client.query("COMMIT");

    await logAuditEvent(eventId, "promise_to_pay_created", {
      promiseId,
      promisedAmount,
      dueAt: input.dueAt.toISOString(),
      reminderAt: reminderAt.toISOString(),
      source: input.source ?? "merchant_or_agent",
      note: input.note ?? null,
      replacedPromiseIds: replaced.rows.map((item) => Number(item.id)),
    });

    return {
      id: promiseId,
      promisedAmount,
      dueAt: input.dueAt,
      reminderAt,
      status: "PENDING",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPromisesForCase(pool: Pool, caseId: number) {
  const result = await pool.query(
    `SELECT id, promised_amount, due_at, status, source, note, created_at, updated_at, fulfilled_at, cancelled_at
     FROM payment_promises
     WHERE case_id = $1
     ORDER BY created_at DESC`,
    [caseId]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    promisedAmount: Number(row.promised_amount),
    dueAt: row.due_at,
    status: String(row.status),
    source: String(row.source),
    note: row.note == null ? null : String(row.note),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fulfilledAt: row.fulfilled_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
  }));
}

export async function reconcilePromiseToPayForRecoveredCase(pool: Pool, caseId: number): Promise<void> {
  const caseResult = await pool.query("SELECT original_event_id, status FROM recovery_cases WHERE id = $1", [caseId]);
  if (caseResult.rows.length === 0 || caseResult.rows[0].status !== "RECOVERED") return;
  const eventId = String(caseResult.rows[0].original_event_id);

  const result = await pool.query(
    `UPDATE payment_promises
     SET status = 'FULFILLED', fulfilled_at = COALESCE(fulfilled_at, now()), updated_at = now()
     WHERE case_id = $1 AND status = 'PENDING'
     RETURNING id`,
    [caseId]
  );
  if (result.rows.length > 0) {
    await pool.query(
      `UPDATE scheduled_actions
       SET status = 'CANCELLED', updated_at = now()
       WHERE case_id = $1 AND desired_action = 'promise_to_pay_reminder' AND status = 'PENDING'`,
      [caseId]
    );
    await logAuditEvent(eventId, "promise_to_pay_fulfilled", { promiseIds: result.rows.map((row) => Number(row.id)) });
  }
}
