import "dotenv/config";
import { Pool } from "pg";
import { chooseAction } from "./chooseAction";
import { applyPolicyGate } from "./policyGate";
import { getPolicyRuntimeContext } from "./policyContext";
import { logAuditEvent } from "../ledger/auditLog";

const pool = new Pool();

async function interveneOnBatch(batchName: string) {
  const diagnosesResult = await pool.query(
    `SELECT d.id AS diagnosis_id, d.event_id, d.root_cause, d.confidence
     FROM diagnoses d
     JOIN recovery_batches rb ON rb.event_id = d.event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );

  for (const row of diagnosesResult.rows) {
    const already = await pool.query("SELECT id FROM interventions WHERE diagnosis_id = $1", [row.diagnosis_id]);
    if (already.rows.length > 0) {
      console.log(`Skipping ${row.event_id} — already has an intervention.`);
      continue;
    }

    const runtime = await getPolicyRuntimeContext(row.event_id);
    const intervention = await chooseAction({
      rootCause: row.root_cause,
      confidence: parseFloat(row.confidence),
      customerFailureCount: runtime.customerFailureCount,
    });

    await logAuditEvent(row.event_id, "intervention_chosen", { chosen_action: intervention.chosen_action, reasoning: intervention.reasoning });

    const policyOutcome = applyPolicyGate({
      chosenAction: intervention.chosen_action,
      automatedRecoveryAttemptCount: runtime.automatedRecoveryAttemptCount,
      customerContactedInLast24h: runtime.customerContactedInLast24h,
      paymentAlreadyRecovered: runtime.paymentAlreadyRecovered,
    });

    await logAuditEvent(row.event_id, "policy_check", {
      result: policyOutcome.result,
      reason: policyOutcome.reason,
      finalAction: policyOutcome.finalAction,
      runtime,
    });

    await pool.query(
      "INSERT INTO interventions (diagnosis_id, chosen_action, reasoning, policy_check_result, final_action) VALUES ($1, $2, $3, $4, $5)",
      [row.diagnosis_id, intervention.chosen_action, intervention.reasoning, policyOutcome.result, policyOutcome.finalAction]
    );

    console.log(`\nEvent: ${row.event_id}`);
    console.log(`  Root cause: ${row.root_cause}`);
    console.log(`  LLM chose: ${intervention.chosen_action} | Policy: ${policyOutcome.result} | Final: ${policyOutcome.finalAction}`);
  }
}

interveneOnBatch("batch_1")
  .catch((err) => {
    console.error("Intervention failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
