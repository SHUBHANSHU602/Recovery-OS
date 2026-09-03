import "dotenv/config";
import { Pool } from "pg";
import { gatherEvidence } from "../evidence/gatherEvidence";
import { diagnose } from "./diagnose";
import { verify } from "../verifier/verify";
import { logAuditEvent } from "../ledger/auditLog";

const pool = new Pool();

async function diagnoseAllInBatch(batchName: string) {
  const batchResult = await pool.query(
    "SELECT event_id, ground_truth_cause FROM recovery_batches WHERE batch_name = $1",
    [batchName]
  );

  let verifierCaught = 0;

  for (const row of batchResult.rows) {
    const already = await pool.query("SELECT id FROM diagnoses WHERE event_id = $1", [row.event_id]);
    if (already.rows.length > 0) {
      console.log(`Skipping ${row.event_id} — already diagnosed.`);
      continue;
    }

    const evidence = await gatherEvidence(row.event_id);
    const diagnosis = await diagnose(evidence);

    await logAuditEvent(row.event_id, "diagnosis", {
      root_cause: diagnosis.root_cause,
      confidence: diagnosis.confidence,
      rationale: diagnosis.rationale,
    });

    const verification = verify(diagnosis, evidence);

    await logAuditEvent(row.event_id, "verification", {
      result: verification.result,
      reason: verification.reason,
      finalRootCause: verification.finalRootCause,
    });

    if (verification.result !== "PASSED") verifierCaught++;

    await pool.query(
      "INSERT INTO diagnoses (event_id, root_cause, rationale, confidence, verifier_result) VALUES ($1, $2, $3, $4, $5)",
      [row.event_id, verification.finalRootCause, diagnosis.rationale, diagnosis.confidence, verification.result]
    );

    const isCorrect = verification.finalRootCause === row.ground_truth_cause;

    console.log(`\nEvent: ${row.event_id}`);
    console.log(`  Ground truth: ${row.ground_truth_cause} | LLM said: ${diagnosis.root_cause} | Verifier: ${verification.result} | Final: ${verification.finalRootCause} | ${isCorrect ? "CORRECT" : "WRONG"}`);
    if (verification.result !== "PASSED") {
      console.log(`  Verifier note: ${verification.reason}`);
    }
  }

  // Compute accuracy from actual current stored state, not just events processed in this run --
  // stays correct even when most/all events were skipped as already-diagnosed.
  const finalCheck = await pool.query(
    `SELECT d.root_cause, rb.ground_truth_cause
     FROM diagnoses d
     JOIN recovery_batches rb ON rb.event_id = d.event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );
  const totalCorrect = finalCheck.rows.filter(r => r.root_cause === r.ground_truth_cause).length;

  console.log(`\n=== Accuracy (current stored state): ${totalCorrect}/${finalCheck.rows.length} ===`);
  console.log(`=== Verifier intervened on (this run only): ${verifierCaught}/${batchResult.rows.length} ===`);
}

diagnoseAllInBatch("batch_1")
  .catch((err) => {
    console.error("Batch diagnosis failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());