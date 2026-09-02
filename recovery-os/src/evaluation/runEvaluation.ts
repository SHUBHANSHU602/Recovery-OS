import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool();

async function runEvaluation(batchName: string) {
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
  const diagnosisAccuracy = totalDiagnoses > 0 ? (correctDiagnoses / totalDiagnoses) * 100 : 0;

  console.log(`--- Diagnosis Accuracy ---`);
  console.log(`${correctDiagnoses}/${totalDiagnoses} correct (${diagnosisAccuracy.toFixed(1)}%)\n`);

  const valueResult = await pool.query(
    `SELECT
       COUNT(*)::int AS total_events,
       COALESCE(SUM((e.payload->'payload'->'payment'->'entity'->>'amount')::bigint), 0)::bigint AS revenue_at_risk,
       COUNT(r.id)::int AS recovered_events,
       COALESCE(SUM(r.recovered_amount), 0)::bigint AS recovered_revenue
     FROM recovery_batches rb
     JOIN events e ON e.event_id = rb.event_id
     LEFT JOIN recoveries r ON r.event_id = rb.event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );

  const values = valueResult.rows[0];
  const totalEvents = Number(values.total_events);
  const recoveredEvents = Number(values.recovered_events);
  const revenueAtRisk = Number(values.revenue_at_risk);
  const recoveredRevenue = Number(values.recovered_revenue);
  const transactionRecoveryRate = totalEvents > 0 ? (recoveredEvents / totalEvents) * 100 : 0;
  const valueRecoveryRate = revenueAtRisk > 0 ? (recoveredRevenue / revenueAtRisk) * 100 : 0;

  console.log(`--- Confirmed Revenue Recovery ---`);
  console.log(`Revenue at risk: ₹${(revenueAtRisk / 100).toFixed(2)}`);
  console.log(`Confirmed recovered revenue: ₹${(recoveredRevenue / 100).toFixed(2)}`);
  console.log(`Recovered transactions: ${recoveredEvents}/${totalEvents} (${transactionRecoveryRate.toFixed(1)}%)`);
  console.log(`Value recovery rate: ${valueRecoveryRate.toFixed(1)}%`);
  console.log(`Only payment completion webhooks count as recovered. Creating a payment link does not.\n`);

  const actionResult = await pool.query(
    `SELECT COUNT(*)::int AS total_actions,
            COUNT(*) FILTER (WHERE status = 'success')::int AS successful_actions
     FROM actions a
     JOIN events e ON e.event_id = a.event_id
     JOIN recovery_batches rb ON rb.event_id = e.event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );
  console.log(`--- Recovery Operations (secondary metric) ---`);
  console.log(`${actionResult.rows[0].successful_actions}/${actionResult.rows[0].total_actions} recorded actions completed successfully.\n`);

  const falseEscalationResult = await pool.query(
    `SELECT i.final_action, rb.ground_truth_cause
     FROM interventions i
     JOIN diagnoses d ON d.id = i.diagnosis_id
     JOIN recovery_batches rb ON rb.event_id = d.event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );
  const falseEscalations = falseEscalationResult.rows.filter(
    (r) => r.final_action === "escalate_to_human" && r.ground_truth_cause !== "ambiguous"
  ).length;
  const totalInterventions = falseEscalationResult.rows.length;
  const falseEscalationRate = totalInterventions > 0 ? (falseEscalations / totalInterventions) * 100 : 0;

  console.log(`--- False-Escalation Rate ---`);
  console.log(`${falseEscalations}/${totalInterventions} (${falseEscalationRate.toFixed(1)}%)\n`);
  console.log(`========== END EVALUATION ==========\n`);
}

runEvaluation("batch_1")
  .catch((err) => {
    console.error("Evaluation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
