import "dotenv/config";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { ensureTrack3Schema } from "./recoveryStore";
import {
  ensureRecoveryPaymentLinkSchema,
  getActiveRecoveryPaymentLink,
  markOriginalPaymentCapturedFinancial,
  markRecoveryFromAnyPaymentLink,
} from "./recoveryPaymentLinks";

const pool = new Pool();
const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
const eventIds: string[] = [];

async function makeEvent(label: string, paymentId: string, amount: number): Promise<string> {
  const eventId = `payment_integrity_${label}_${suffix}`;
  eventIds.push(eventId);
  await pool.query(
    `INSERT INTO events(event_id, event_type, payload)
     VALUES ($1, 'payment.failed', $2)`,
    [eventId, { payload: { payment: { entity: { id: paymentId, email: `${label}.${suffix}@example.com`, amount } } } }]
  );
  return eventId;
}

async function makeCase(
  eventId: string,
  paymentId: string,
  amount: number,
  status: string,
  financialStatus: string,
  automationStatus: string,
  currentLink: string | null
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO recovery_cases
       (original_event_id, original_payment_id, customer_email, amount_at_risk, status,
        financial_status, automation_status, razorpay_payment_link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [eventId, paymentId, `${eventId}@example.com`, amount, status, financialStatus, automationStatus, currentLink]
  );
  return Number(result.rows[0].id);
}

async function testOlderLinkCanRecoverEscalatedCase(): Promise<void> {
  const eventId = await makeEvent("older_link", `pay_old_${suffix}`, 10000);
  const oldLink = `plink_old_${suffix}`;
  const newLink = `plink_new_${suffix}`;
  const caseId = await makeCase(eventId, `pay_old_${suffix}`, 10000, "ESCALATED", "OPEN", "ESCALATED", newLink);

  await pool.query(
    `INSERT INTO human_escalations(case_id, event_id, reason, status)
     VALUES ($1, $2, 'automation exhausted', 'OPEN')`,
    [caseId, eventId]
  );
  await pool.query(
    `INSERT INTO recovery_payment_links(case_id, payment_link_id, short_url, status, provider_status, amount)
     VALUES
       ($1, $2, 'https://example.test/old', 'SUPERSEDED', 'created', 10000),
       ($1, $3, 'https://example.test/new', 'ACTIVE', 'created', 10000)`,
    [caseId, oldLink, newLink]
  );

  const recovery = await markRecoveryFromAnyPaymentLink(pool, oldLink, 10000);
  assert.equal(recovery.transitioned, true, "a trusted older link must recover an escalated financial case");
  assert.equal(recovery.caseId, caseId);

  const caseRow = await pool.query(
    `SELECT status, financial_status, automation_status, recovered_amount,
            razorpay_payment_link_id, terminal_reason
     FROM recovery_cases WHERE id = $1`,
    [caseId]
  );
  assert.equal(caseRow.rows[0].status, "RECOVERED");
  assert.equal(caseRow.rows[0].financial_status, "RECOVERED");
  assert.equal(caseRow.rows[0].automation_status, "STOPPED");
  assert.equal(Number(caseRow.rows[0].recovered_amount), 10000);
  assert.equal(caseRow.rows[0].razorpay_payment_link_id, oldLink);
  assert.equal(caseRow.rows[0].terminal_reason, "trusted_payment_link_paid");

  const links = await pool.query(
    `SELECT payment_link_id, status FROM recovery_payment_links WHERE case_id = $1 ORDER BY payment_link_id`,
    [caseId]
  );
  const states = Object.fromEntries(links.rows.map((row) => [row.payment_link_id, row.status]));
  assert.equal(states[oldLink], "PAID");
  assert.equal(states[newLink], "SUPERSEDED");

  const escalation = await pool.query(`SELECT status, resolved_at FROM human_escalations WHERE case_id = $1`, [caseId]);
  assert.equal(escalation.rows[0].status, "RESOLVED");
  assert.ok(escalation.rows[0].resolved_at, "human escalation should close after trusted recovery");
}

async function testFinancialStopRejectsLateRecovery(): Promise<void> {
  const eventId = await makeEvent("stopped", `pay_stopped_${suffix}`, 12000);
  const link = `plink_stopped_${suffix}`;
  const caseId = await makeCase(eventId, `pay_stopped_${suffix}`, 12000, "STOPPED", "STOPPED", "STOPPED", link);
  await pool.query(
    `INSERT INTO recovery_payment_links(case_id, payment_link_id, status, provider_status, amount)
     VALUES ($1, $2, 'ACTIVE', 'created', 12000)`,
    [caseId, link]
  );

  const recovery = await markRecoveryFromAnyPaymentLink(pool, link, 12000);
  assert.equal(recovery.transitioned, false, "financially STOPPED case must not become recovered");

  const row = await pool.query(`SELECT status, financial_status, recovered_amount FROM recovery_cases WHERE id = $1`, [caseId]);
  assert.equal(row.rows[0].status, "STOPPED");
  assert.equal(row.rows[0].financial_status, "STOPPED");
  assert.equal(Number(row.rows[0].recovered_amount), 0);
}

async function testOnlyOneActiveLinkPerCase(): Promise<void> {
  const eventId = await makeEvent("one_active", `pay_active_${suffix}`, 14000);
  const caseId = await makeCase(eventId, `pay_active_${suffix}`, 14000, "WAITING_FOR_OUTCOME", "OPEN", "WAITING", null);
  const first = `plink_active_a_${suffix}`;
  const second = `plink_active_b_${suffix}`;

  await pool.query(
    `INSERT INTO recovery_payment_links(case_id, payment_link_id, status, provider_status, amount)
     VALUES ($1, $2, 'ACTIVE', 'created', 14000)`,
    [caseId, first]
  );

  let uniqueViolation = false;
  try {
    await pool.query(
      `INSERT INTO recovery_payment_links(case_id, payment_link_id, status, provider_status, amount)
       VALUES ($1, $2, 'ACTIVE', 'created', 14000)`,
      [caseId, second]
    );
  } catch (error: any) {
    uniqueViolation = error?.code === "23505";
  }
  assert.equal(uniqueViolation, true, "database must reject a second ACTIVE recovery link for the same case");

  const active = await getActiveRecoveryPaymentLink(pool, caseId);
  assert.equal(active?.paymentLinkId, first);
}

async function testOriginalCaptureStopsEscalatedFinancialCase(): Promise<void> {
  const paymentId = `pay_capture_${suffix}`;
  const eventId = await makeEvent("captured_after_escalation", paymentId, 16000);
  const link = `plink_capture_${suffix}`;
  const caseId = await makeCase(eventId, paymentId, 16000, "ESCALATED", "OPEN", "ESCALATED", link);
  await pool.query(
    `INSERT INTO recovery_payment_links(case_id, payment_link_id, status, provider_status, amount)
     VALUES ($1, $2, 'ACTIVE', 'created', 16000)`,
    [caseId, link]
  );

  const stopped = await markOriginalPaymentCapturedFinancial(pool, paymentId);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].caseId, caseId);

  const row = await pool.query(
    `SELECT status, financial_status, automation_status, recovered_amount, terminal_reason
     FROM recovery_cases WHERE id = $1`,
    [caseId]
  );
  assert.equal(row.rows[0].status, "STOPPED");
  assert.equal(row.rows[0].financial_status, "STOPPED");
  assert.equal(row.rows[0].automation_status, "STOPPED");
  assert.equal(Number(row.rows[0].recovered_amount), 0);
  assert.equal(row.rows[0].terminal_reason, "original_payment_captured");
}

async function cleanup(): Promise<void> {
  for (const eventId of eventIds) {
    const cases = await pool.query(`SELECT id FROM recovery_cases WHERE original_event_id = $1`, [eventId]);
    for (const row of cases.rows) {
      await pool.query(`DELETE FROM recovery_cases WHERE id = $1`, [row.id]);
    }
    await pool.query(`DELETE FROM events WHERE event_id = $1`, [eventId]);
  }
}

async function main(): Promise<void> {
  await ensureTrack3Schema(pool);
  await ensureRecoveryPaymentLinkSchema(pool);
  try {
    await testOlderLinkCanRecoverEscalatedCase();
    await testFinancialStopRejectsLateRecovery();
    await testOnlyOneActiveLinkPerCase();
    await testOriginalCaptureStopsEscalatedFinancialCase();
    console.log("Payment integrity tests PASS");
    console.log("- historical Payment Link can close an escalated financial case");
    console.log("- financially stopped cases cannot be reclassified as recovered");
    console.log("- database enforces at most one ACTIVE recovery Payment Link per case");
    console.log("- original payment capture stops financial tracking even after escalation");
  } finally {
    await cleanup();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Payment integrity tests FAILED:", error);
  process.exitCode = 1;
});
