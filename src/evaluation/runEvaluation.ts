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

  // Business outcome: one row per original failed transaction, confirmed only by trusted outcome state.
  const recoveryResult = await pool.query(
    `SELECT rc.amount_at_risk, rc.recovered_amount, rc.status, rc.strategy
     FROM recovery_cases rc
     JOIN recovery_batches rb ON rb.event_id = rc.original_event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );
  const cases = recoveryResult.rows;
  const atRisk = cases.reduce((sum, row) => sum + Number(row.amount_at_risk ?? 0), 0);
  const recovered = cases.reduce((sum, row) => sum + Number(row.recovered_amount ?? 0), 0);
  const recoveredTransactions = cases.filter((row) => row.status === "RECOVERED").length;
  const valueRecoveryRate = atRisk ? (recovered / atRisk) * 100 : 0;
  const transactionRecoveryRate = cases.length ? (recoveredTransactions / cases.length) * 100 : 0;

  console.log(`--- Confirmed Revenue Recovery ---`);
  console.log(`Revenue at risk: ₹${(atRisk / 100).toFixed(2)}`);
  console.log(`Confirmed recovered revenue: ₹${(recovered / 100).toFixed(2)}`);
  console.log(`Value recovery rate: ${valueRecoveryRate.toFixed(1)}%`);
  console.log(`Transaction recovery rate: ${recoveredTransactions}/${cases.length} (${transactionRecoveryRate.toFixed(1)}%)`);
  console.log(`Unresolved amount: ₹${((atRisk - recovered) / 100).toFixed(2)}\n`);

  // Operational action reliability is deliberately separate from customer recovery.
  const actionsResult = await pool.query(
    `SELECT a.status
     FROM actions a
     LEFT JOIN interventions i ON i.id = a.intervention_id
     LEFT JOIN diagnoses d ON d.id = i.diagnosis_id
     LEFT JOIN recovery_batches rb ON rb.event_id = d.event_id
     WHERE rb.batch_name = $1 OR a.idempotency_key IN (
       SELECT original_event_id || '_retry_now' FROM recovery_cases rc
       JOIN recovery_batches b ON b.event_id = rc.original_event_id WHERE b.batch_name = $1
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

  console.log(`========== END EVALUATION ==========\n`);
}

runEvaluation("batch_1")
  .catch((err) => {
    console.error("Evaluation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
