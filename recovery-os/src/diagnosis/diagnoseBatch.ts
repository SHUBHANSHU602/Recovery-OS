import "dotenv/config";
import { Pool } from "pg";
import { gatherEvidence } from "../evidence/gatherEvidence";
import { diagnose } from "./diagnose";
import { verify } from "../verifier/verify";

const pool = new Pool();

async function diagnoseAllInBatch(batchName: string) {
  // Clear any previous diagnoses for this batch first, so reruns never leave stale duplicates behind
  await pool.query(
    `DELETE FROM diagnoses WHERE event_id IN (SELECT event_id FROM recovery_batches WHERE batch_name = $1)`,
    [batchName]
  );

  const batchResult = await pool.query(
    "SELECT event_id, ground_truth_cause FROM recovery_batches WHERE batch_name = $1",
    [batchName]
  );

  let correct = 0;
  let verifierCaught = 0;

  for (const row of batchResult.rows) {
    const evidence = await gatherEvidence(row.event_id);
    const diagnosis = await diagnose(evidence);
    const verification = verify(diagnosis, evidence);

    if (verification.result !== "PASSED") verifierCaught++;

    await pool.query(
      "INSERT INTO diagnoses (event_id, root_cause, rationale, confidence, verifier_result) VALUES ($1, $2, $3, $4, $5)",
      [row.event_id, verification.finalRootCause, diagnosis.rationale, diagnosis.confidence, verification.result]
    );

    const isCorrect = verification.finalRootCause === row.ground_truth_cause;
    if (isCorrect) correct++;

    console.log(`\nEvent: ${row.event_id}`);
    console.log(`  Ground truth: ${row.ground_truth_cause} | LLM said: ${diagnosis.root_cause} | Verifier: ${verification.result} | Final: ${verification.finalRootCause} | ${isCorrect ? "✓" : "✗"}`);
    if (verification.result !== "PASSED") {
      console.log(`  Verifier note: ${verification.reason}`);
    }
  }

  console.log(`\n=== Accuracy: ${correct}/${batchResult.rows.length} ===`);
  console.log(`=== Verifier intervened on: ${verifierCaught}/${batchResult.rows.length} ===`);
}

diagnoseAllInBatch("batch_1")
  .catch((err) => {
    console.error("Batch diagnosis failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());