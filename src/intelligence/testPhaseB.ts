import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  causeAwareInitialDelaySeconds,
  estimateRecoveryProbability,
  expectedRecoveryValue,
  isQuietHours,
  nextAllowedContactTime,
  refreshRecoveryPriority,
} from "./recoveryIntelligence";
import { createPromiseToPay, listPromisesForCase } from "./paymentPromises";
import { ensureRecoveryCase, ensureTrack3Schema } from "../recovery/recoveryStore";

async function main() {
  const quietConfig = { timeZone: "UTC", quietStartHour: 21, quietEndHour: 8 };
  assert.equal(isQuietHours(new Date("2026-09-04T23:30:00Z"), quietConfig), true);
  assert.equal(isQuietHours(new Date("2026-09-04T12:00:00Z"), quietConfig), false);
  assert.equal(nextAllowedContactTime(new Date("2026-09-04T23:30:00Z"), quietConfig).toISOString(), "2026-09-05T08:00:00.000Z");

  assert.equal(causeAwareInitialDelaySeconds("systemic_bank_outage"), 1800);
  assert.equal(causeAwareInitialDelaySeconds("insufficient_funds"), 21600);
  assert.equal(causeAwareInitialDelaySeconds("expired_card"), 43200);
  assert.equal(causeAwareInitialDelaySeconds("ambiguous"), 3600);
  assert.equal(causeAwareInitialDelaySeconds("unknown"), 300);

  const probability = estimateRecoveryProbability({ rootCause: "systemic_bank_outage", historicalCases: 6, historicalRecoveries: 3 });
  assert.ok(probability > 0 && probability < 1);
  assert.equal(expectedRecoveryValue(10000, 0.5), 5000);

  const pool = new Pool();
  let eventId: string | null = null;

  try {
    await ensureTrack3Schema(pool);
    eventId = `phase_b_test_${randomUUID()}`;
    const paymentId = `pay_phase_b_${randomUUID()}`;

    await pool.query(
      `INSERT INTO events (event_id, event_type, payload)
       VALUES ($1, 'payment.failed', $2)`,
      [eventId, {
        event: "payment.failed",
        payload: { payment: { entity: {
          id: paymentId,
          amount: 10000,
          currency: "INR",
          email: "phase-b-test@example.com",
          bank: "AXIS",
          error_code: "GATEWAY_ERROR",
          error_description: "Payment authorization timed out",
          created_at: Math.floor(Date.now() / 1000) - 60,
        } } },
      }]
    );

    const caseId = await ensureRecoveryCase(pool, eventId);
    assert.ok(caseId);
    await pool.query(
      `INSERT INTO diagnoses (event_id, root_cause, rationale, confidence, verifier_result)
       VALUES ($1, 'systemic_bank_outage', 'test', 0.9, 'PASSED')`,
      [eventId]
    );
    await pool.query("UPDATE recovery_cases SET strategy = 'retry_with_backoff' WHERE id = $1", [caseId]);

    const priority = await refreshRecoveryPriority(pool, Number(caseId), "retry_with_backoff");
    assert.ok(priority.recoveryProbability >= 0.05 && priority.recoveryProbability <= 0.95);
    assert.equal(priority.expectedRecoveryValue, Math.round(10000 * priority.recoveryProbability));

    const persistedPriority = await pool.query(
      "SELECT recovery_probability, expected_recovery_value FROM recovery_cases WHERE id = $1",
      [caseId]
    );
    assert.equal(Number(persistedPriority.rows[0].expected_recovery_value), priority.expectedRecoveryValue);

    const firstDueAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const firstPromise = await createPromiseToPay(pool, {
      caseId: Number(caseId),
      promisedAmount: 7500,
      dueAt: firstDueAt,
      source: "phase_b_test",
      note: "customer promised later payment",
    });
    assert.equal(firstPromise.promisedAmount, 7500);

    const secondDueAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const secondPromise = await createPromiseToPay(pool, {
      caseId: Number(caseId),
      promisedAmount: 6000,
      dueAt: secondDueAt,
      source: "phase_b_test",
      note: "customer replaced the earlier promise",
    });
    assert.equal(secondPromise.promisedAmount, 6000);

    const promises = await listPromisesForCase(pool, Number(caseId));
    assert.equal(promises.length, 2);
    const persistedFirst = promises.find((item) => item.id === firstPromise.id);
    const persistedSecond = promises.find((item) => item.id === secondPromise.id);
    assert.equal(persistedFirst?.status, "CANCELLED");
    assert.equal(persistedSecond?.status, "PENDING");

    const scheduled = await pool.query(
      `SELECT schedule_key, status FROM scheduled_actions
       WHERE case_id = $1 AND desired_action = 'promise_to_pay_reminder'
       ORDER BY id`,
      [caseId]
    );
    assert.equal(scheduled.rows.length, 2);
    const firstReminder = scheduled.rows.find((row) => String(row.schedule_key).includes(`promise_${firstPromise.id}_reminder`));
    const secondReminder = scheduled.rows.find((row) => String(row.schedule_key).includes(`promise_${secondPromise.id}_reminder`));
    assert.equal(firstReminder?.status, "CANCELLED");
    assert.equal(secondReminder?.status, "PENDING");

    console.log("Phase B intelligence tests passed.");
  } finally {
    if (eventId) {
      await pool.query("DELETE FROM recovery_cases WHERE original_event_id = $1", [eventId]);
      await pool.query("DELETE FROM events WHERE event_id = $1", [eventId]);
    }
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Phase B intelligence tests failed:", error);
  process.exitCode = 1;
});
