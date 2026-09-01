import "dotenv/config";
import { Pool } from "pg";
import { executeAction } from "./execute";

const pool = new Pool();

async function executeAllInBatch(batchName: string) {
  const result = await pool.query(
    `SELECT i.id AS intervention_id, i.final_action, d.event_id,
            (e.payload->'payload'->'payment'->'entity'->>'amount')::int AS amount,
            e.payload->'payload'->'payment'->'entity'->>'email' AS customer_email
     FROM interventions i
     JOIN diagnoses d ON d.id = i.diagnosis_id
     JOIN events e ON e.event_id = d.event_id
     JOIN recovery_batches rb ON rb.event_id = d.event_id
     WHERE rb.batch_name = $1`,
    [batchName]
  );

  for (const row of result.rows) {
    await executeAction({
      eventId: row.event_id,
      interventionId: row.intervention_id,
      finalAction: row.final_action,
      amount: row.amount,
      customerEmail: row.customer_email,
    });
  }
}

executeAllInBatch("batch_1")
  .catch((err) => {
    console.error("Batch execution failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());