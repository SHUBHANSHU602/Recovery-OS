import "dotenv/config";
import { Pool } from "pg";
import { executeAction } from "./execute";
import { ensureRecoveryCase, ensureTrack3Schema } from "../recovery/recoveryStore";

const pool = new Pool();

export async function executeAllInBatch(batchName: string) {
  await ensureTrack3Schema(pool);

  const result = await pool.query(
    `SELECT i.id AS intervention_id, i.final_action, d.event_id,
            (e.payload->'payload'->'payment'->'entity'->>'amount')::int AS amount,
            e.payload->'payload'->'payment'->'entity'->>'email' AS customer_email
     FROM interventions i
     JOIN diagnoses d ON d.id = i.diagnosis_id
     JOIN events e ON e.event_id = d.event_id
     JOIN recovery_batches rb ON rb.event_id = d.event_id
     WHERE rb.batch_name = $1
     ORDER BY d.event_id`,
    [batchName]
  );

  if (result.rows.length === 0) {
    throw new Error(`Batch ${batchName} has no interventions to execute.`);
  }

  let preparedCases = 0;
  for (const row of result.rows) {
    // A recovery case is derived from the trusted stored payment event. This does
    // not mark anything recovered; it only establishes amount-at-risk and the
    // durable business identity used by the closed-loop recovery pipeline.
    const caseId = await ensureRecoveryCase(pool, String(row.event_id));
    if (!caseId) {
      throw new Error(`Could not create recovery case for ${row.event_id}`);
    }
    preparedCases += 1;

    await executeAction({
      eventId: String(row.event_id),
      interventionId: Number(row.intervention_id),
      finalAction: String(row.final_action),
      amount: Number(row.amount),
      customerEmail: String(row.customer_email ?? ""),
    });
  }

  console.log(`Prepared ${preparedCases}/${result.rows.length} recovery case(s) from stored batch events.`);
  console.log("Recovery revenue remains unconfirmed until trusted payment_link.paid outcome webhooks arrive.");
}

if (require.main === module) {
  executeAllInBatch("batch_1")
    .catch((err) => {
      console.error("Batch execution failed:", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
