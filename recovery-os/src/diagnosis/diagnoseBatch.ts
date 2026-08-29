import "dotenv/config";
import { Pool } from "pg";
import { gatherEvidence } from "../evidence/gatherEvidence";
import { diagnose } from "./diagnose";

const pool = new Pool();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function diagnoseAllInBatch(batchName: string) {
  const batchResult = await pool.query(
    "SELECT event_id, ground_truth_cause FROM recovery_batches WHERE batch_name = $1",
    [batchName]
  );

  let correct = 0;

  for (const row of batchResult.rows) {
    const evidence = await gatherEvidence(row.event_id);
    const diagnosis = await diagnose(evidence);

    await pool.query(
      "INSERT INTO diagnoses (event_id, root_cause, rationale, confidence) VALUES ($1, $2, $3, $4)",
      [row.event_id, diagnosis.root_cause, diagnosis.rationale, diagnosis.confidence]
    );

    const isCorrect = diagnosis.root_cause === row.ground_truth_cause;
    if (isCorrect) correct++;

    console.log(`\nEvent: ${row.event_id}`);
    console.log(`  Ground truth: ${row.ground_truth_cause} | Predicted: ${diagnosis.root_cause} | ${isCorrect ? "✓" : "✗"}`);
    console.log(`  Confidence: ${diagnosis.confidence}`);
    console.log(`  Rationale: ${diagnosis.rationale}`);

    await sleep(13000); // stay under Gemini free-tier 5 req/min limit
  }

  console.log(`\n=== Accuracy: ${correct}/${batchResult.rows.length} ===`);
}

diagnoseAllInBatch("batch_1")
  .catch((err) => {
    console.error("Batch diagnosis failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());