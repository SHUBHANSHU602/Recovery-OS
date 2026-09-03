import "dotenv/config";
import { Pool } from "pg";
import { ensureTrack3Schema } from "../recovery/recoveryStore";

const pool = new Pool();

async function runEvaluation(batchName: string) {
  await ensureTrack3Schema(pool);
  console.log(`\n========== EVALUATION: ${batchName} ==========\n`);

  const diagnosisResult = await pool.query(
    `SELECT d.root_cause, rb.ground_truth_cause, d.verifier_result
     FROM diagnoses d
     JOIN recovery_batches rb ON rb.event_id = d.event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );
  const totalDiagnoses = diagnosisResult.rows.length;
  const correctDiagnoses = diagnosisResult.rows.filter((r) => r.root_cause === r.ground_truth_cause).length;
  const diagnosisAccuracy = totalDiagnoses ? (correctDiagnoses / totalDiagnoses) * 100 : 0;
  console.log(`--- Diagnosis Accuracy ---`);
  console.log(`${correctDiagnoses}/${totalDiagnoses} correct (${diagnosisAccuracy.toFixed(1)}%)\n`);

  const verifierInterventions = diagnosisResult.rows.filter((r) => r.verifier_result !== "PASSED").length;
  console.log(`--- Verifier Behavior ---`);
  console.log(`Intervened on ${verifierInterventions}/${totalDiagnoses} diagnoses.\n`);

  const batchCountResult = await pool.query(
    `SELECT COUNT(*)
     FROM recovery_batches
     WHERE batch_name = $1`,
    [batchName]
  );
  const batchEventCount = Number(batchCountResult.rows[0]?.count ?? 0);

  const recoveryResult = await pool.query(
    `SELECT rc.original_event_id, rc.amount_at_risk, rc.recovered_amount, rc.status, rc.strategy,
            rc.razorpay_payment_link_id, rc.recovered_at, rc.terminal_reason
     FROM recovery_cases rc
     JOIN recovery_batches rb ON rb.event_id = rc.original_event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );
  const cases = recoveryResult.rows;
  const recoveryCoverageComplete = batchEventCount > 0 && cases.length === batchEventCount;

  console.log(`--- Recovery-Case Coverage ---`);
  console.log(`${cases.length}/${batchEventCount} batch event(s) have durable recovery cases.`);
  if (!recoveryCoverageComplete) {
    console.log(
      `Revenue recovery rates are NOT reported because the batch has not been fully materialized into recovery cases.`
    );
    console.log(`Run the batch execution path first so amount-at-risk comes from the stored payment events.\n`);
  } else {
    const atRisk = cases.reduce((sum, row) => sum + Number(row.amount_at_risk ?? 0), 0);
    const recovered = cases.reduce((sum, row) => sum + Number(row.recovered_amount ?? 0), 0);
    const recoveredTransactions = cases.filter(
      (row) => row.status === "RECOVERED" && Number(row.recovered_amount ?? 0) > 0 && row.recovered_at != null
    ).length;
    const valueRecoveryRate = atRisk ? (recovered / atRisk) * 100 : 0;
    const transactionRecoveryRate = cases.length ? (recoveredTransactions / cases.length) * 100 : 0;

    console.log(`--- Confirmed Revenue Recovery ---`);
    console.log(`Revenue at risk: ₹${(atRisk / 100).toFixed(2)}`);
    console.log(`Confirmed recovered revenue: ₹${(recovered / 100).toFixed(2)}`);
    console.log(`Value recovery rate: ${valueRecoveryRate.toFixed(1)}%`);
    console.log(`Transaction recovery rate: ${recoveredTransactions}/${cases.length} (${transactionRecoveryRate.toFixed(1)}%)`);
    console.log(`Unresolved amount: ₹${((atRisk - recovered) / 100).toFixed(2)}`);
    console.log(`A case counts as recovered only after persisted trusted outcome state, never from action/API success.\n`);

    const strategy = new Map<string, { cases: number; recoveredCases: number; recoveredAmount: number }>();
    for (const row of cases) {
      const key = String(row.strategy ?? "unassigned");
      const current = strategy.get(key) ?? { cases: 0, recoveredCases: 0, recoveredAmount: 0 };
      current.cases += 1;
      current.recoveredCases += row.status === "RECOVERED" && Number(row.recovered_amount ?? 0) > 0 ? 1 : 0;
      current.recoveredAmount += Number(row.recovered_amount ?? 0);
      strategy.set(key, current);
    }
    console.log(`--- Recovery by Strategy ---`);
    for (const [name, metrics] of strategy.entries()) {
      console.log(`${name}: ${metrics.recoveredCases}/${metrics.cases} recovered, ₹${(metrics.recoveredAmount / 100).toFixed(2)}`);
    }
    console.log();
  }

  // Match all concrete attempt/contact keys for batch events, not one legacy exact key shape.
  const actionsResult = await pool.query(
    `SELECT DISTINCT a.id, a.status
     FROM actions a
     LEFT JOIN interventions i ON i.id = a.intervention_id
     LEFT JOIN diagnoses d ON d.id = i.diagnosis_id
     LEFT JOIN recovery_batches rb ON rb.event_id = d.event_id
     WHERE rb.batch_name = $1
        OR EXISTS (
          SELECT 1
          FROM recovery_cases rc
          JOIN recovery_batches b ON b.event_id = rc.original_event_id
          WHERE b.batch_name = $1
            AND a.idempotency_key LIKE rc.original_event_id || '_%'
        )`,
    [batchName]
  );
  const successfulActions = actionsResult.rows.filter((r) => r.status === "success").length;
  console.log(`--- Execution Reliability (not revenue recovery) ---`);
  console.log(`${successfulActions}/${actionsResult.rows.length} recorded actions completed successfully.\n`);

  const interventionsResult = await pool.query(
    `SELECT i.final_action, rb.ground_truth_cause
     FROM interventions i
     JOIN diagnoses d ON d.id = i.diagnosis_id
     JOIN recovery_batches rb ON rb.event_id = d.event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );
  const falseEscalations = interventionsResult.rows.filter(
    (r) => r.final_action === "escalate_to_human" && r.ground_truth_cause !== "ambiguous"
  ).length;
  const falseEscalationRate = interventionsResult.rows.length
    ? (falseEscalations / interventionsResult.rows.length) * 100
    : 0;
  console.log(`--- False-Escalation Rate ---`);
  console.log(`${falseEscalations}/${interventionsResult.rows.length} (${falseEscalationRate.toFixed(1)}%)\n`);

  const escalationResult = await pool.query(
    `SELECT COUNT(*)
     FROM human_escalations he
     JOIN recovery_cases rc ON rc.id = he.case_id
     JOIN recovery_batches rb ON rb.event_id = rc.original_event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );
  console.log(`--- Human Escalation Work Items ---`);
  console.log(`${Number(escalationResult.rows[0]?.count ?? 0)} durable escalation work item(s).\n`);

  console.log(`========== END EVALUATION ==========\n`);
}

runEvaluation("batch_1")
  .catch((err) => {
    console.error("Evaluation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
