import "dotenv/config";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { ensureRecoveryCase, ensureTrack3Schema, markRecoveryFromPaymentLink } from "../recovery/recoveryStore";
import {
  getDashboardSummary,
  getRecoveryCase,
  getRecoveryCaseTimeline,
  listHumanEscalations,
  listRecoveryCases,
} from "./dashboardService";

// max:1 guarantees every pool.query in this integration test uses the same
// physical PostgreSQL connection, so the test fixture can be rolled back.
const pool = new Pool({ max: 1 });

async function main() {
  await ensureTrack3Schema(pool);
  await pool.query("BEGIN");

  try {
    const eventId = `dashboard_test_${Date.now()}`;
    const paymentId = `pay_dashboard_${Date.now()}`;
    const amount = 12345;
    const payload = {
      entity: "event",
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: paymentId,
            amount,
            currency: "INR",
            status: "failed",
            method: "card",
            email: "dashboard-test@example.com",
            bank: "HDFC",
            error_code: "BAD_REQUEST_ERROR",
            error_description: "Insufficient balance in account",
            created_at: Math.floor(Date.now() / 1000),
          },
        },
      },
    };

    await pool.query(
      "INSERT INTO events (event_id, event_type, payload) VALUES ($1, 'payment.failed', $2)",
      [eventId, payload]
    );
    await pool.query(
      "INSERT INTO recovery_batches (batch_name, event_id, ground_truth_cause) VALUES ('dashboard_test', $1, 'insufficient_funds')",
      [eventId]
    );

    const caseId = await ensureRecoveryCase(pool, eventId);
    assert.ok(caseId, "dashboard test recovery case should be created");

    const diagnosis = await pool.query(
      `INSERT INTO diagnoses (event_id, root_cause, rationale, confidence, verifier_result)
       VALUES ($1, 'insufficient_funds', 'Test diagnosis', 0.93, 'PASSED')
       RETURNING id`,
      [eventId]
    );
    await pool.query(
      `INSERT INTO interventions (diagnosis_id, chosen_action, reasoning, policy_check_result, final_action)
       VALUES ($1, 'retry_now', 'Test intervention', 'APPROVED', 'retry_now')`,
      [diagnosis.rows[0].id]
    );
    await pool.query(
      `INSERT INTO audit_log (event_id, stage, detail)
       VALUES ($1, 'dashboard_test_stage', '{"verified":true}'::jsonb)`,
      [eventId]
    );

    const paymentLinkId = `plink_dashboard_${Date.now()}`;
    const recovered = await markRecoveryFromPaymentLink(pool, paymentLinkId, amount, `recovery_case_${caseId}`);
    assert.equal(recovered, true, "trusted payment link outcome should transition the case");

    const summary = await getDashboardSummary(pool);
    assert.ok(summary.totalCases >= 1, "summary should report durable cases");
    assert.ok(summary.confirmedRecovered >= amount, "summary should report trusted recovered value");
    assert.ok(summary.recoveredCases >= 1, "summary should report recovered cases");

    // Search by this test's unique event id so stale fixtures from an older local
    // checkout cannot make the assertion ambiguous.
    const listed = await listRecoveryCases(pool, { search: eventId });
    assert.equal(listed.cases.length, 1, "case search should find exactly this dashboard fixture");
    assert.equal(listed.cases[0].status, "RECOVERED");
    assert.equal(listed.cases[0].recoveredAmount, amount);
    assert.equal(listed.cases[0].rootCause, "insufficient_funds");
    assert.equal(listed.cases[0].verifierResult, "PASSED");

    const detail = await getRecoveryCase(pool, Number(caseId));
    assert.ok(detail, "case detail should load");
    assert.equal(detail?.razorpayPaymentLinkId, paymentLinkId);

    const timeline = await getRecoveryCaseTimeline(pool, Number(caseId));
    assert.ok(timeline, "case timeline should load");
    assert.ok(timeline?.events.some((event) => event.stage === "dashboard_test_stage"));

    const escalations = await listHumanEscalations(pool);
    assert.ok(Array.isArray(escalations.items));

    console.log("Dashboard integration test passed.");
  } finally {
    await pool.query("ROLLBACK");
  }
}

main()
  .catch((error) => {
    console.error("Dashboard integration test failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
