import "dotenv/config";
import { Pool } from "pg";
import { chooseAction } from "./chooseAction";
import { applyPolicyGate } from "./policyGate";

const pool = new Pool();

async function interveneOnBatch(batchName: string) {
  // Get every diagnosis produced for this batch (from Day 5's run)
  const diagnosesResult = await pool.query(
    `SELECT d.id AS diagnosis_id, d.event_id, d.root_cause, d.confidence
     FROM diagnoses d
     JOIN recovery_batches rb ON rb.event_id = d.event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );

  for (const row of diagnosesResult.rows) {
    // In real data every synthetic customer has 0 prior failures (Day 3 built them that way) --
    // hardcoding 0/false here for now since we don't have a live customer-history query wired up yet.
    // This is a known simplification, not a bug -- flagged below.
    const customerFailureCount = 0;
    const customerContactedInLast24h = false;

    const intervention = await chooseAction({
      rootCause: row.root_cause,
      confidence: parseFloat(row.confidence),
      customerFailureCount,
    });

    const policyOutcome = applyPolicyGate({
      chosenAction: intervention.chosen_action,
      customerFailureCount,
      customerContactedInLast24h,
    });

    await pool.query(
      "INSERT INTO interventions (diagnosis_id, chosen_action, reasoning, policy_check_result, final_action) VALUES ($1, $2, $3, $4, $5)",
      [row.diagnosis_id, intervention.chosen_action, intervention.reasoning, policyOutcome.result, policyOutcome.finalAction]
    );

    console.log(`\nEvent: ${row.event_id}`);
    console.log(`  Root cause: ${row.root_cause}`);
    console.log(`  LLM chose: ${intervention.chosen_action} | Policy: ${policyOutcome.result} | Final: ${policyOutcome.finalAction}`);
    console.log(`  Reasoning: ${intervention.reasoning}`);
  }
}

interveneOnBatch("batch_1")
  .catch((err) => {
    console.error("Intervention failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());