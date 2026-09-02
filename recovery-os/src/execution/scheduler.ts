import "dotenv/config";
import { Pool } from "pg";
import { executeRecoveryPaymentLink } from "./paymentLinkExecutor";
import { logAuditEvent } from "../ledger/auditLog";

const pool = new Pool();

export async function scheduleRecoveryPaymentLink(
  eventId: string,
  interventionId: number,
  delaySeconds: number
): Promise<void> {
  await pool.query(
    `INSERT INTO scheduled_recovery_actions
       (event_id, intervention_id, action_type, execute_after, status)
     VALUES ($1, $2, 'retry_with_backoff', now() + ($3 * interval '1 second'), 'scheduled')
     ON CONFLICT (event_id, action_type) DO NOTHING`,
    [eventId, interventionId, delaySeconds]
  );

  await logAuditEvent(eventId, "recovery_scheduled", { delaySeconds, actionType: "retry_with_backoff" });
}

export async function runDueScheduledActions(limit = 20): Promise<number> {
  const due = await pool.query(
    `SELECT s.id, s.event_id, s.intervention_id,
            (e.payload->'payload'->'payment'->'entity'->>'amount')::int AS amount,
            e.payload->'payload'->'payment'->'entity'->>'email' AS customer_email
     FROM scheduled_recovery_actions s
     JOIN events e ON e.event_id = s.event_id
     WHERE s.status = 'scheduled' AND s.execute_after <= now()
     ORDER BY s.execute_after
     LIMIT $1`,
    [limit]
  );

  let processed = 0;
  for (const row of due.rows) {
    const claimed = await pool.query(
      `UPDATE scheduled_recovery_actions
       SET status = 'processing'
       WHERE id = $1 AND status = 'scheduled'
       RETURNING id`,
      [row.id]
    );
    if (claimed.rows.length === 0) continue;

    const result = await executeRecoveryPaymentLink({
      eventId: row.event_id,
      interventionId: row.intervention_id,
      amount: row.amount,
      customerEmail: row.customer_email,
      actionType: "retry_with_backoff",
    });

    await pool.query(
      "UPDATE scheduled_recovery_actions SET status = $1 WHERE id = $2",
      [result.status === "success" || result.status === "already_executed" ? "done" : "failed", row.id]
    );
    processed++;
  }

  return processed;
}

if (require.main === module) {
  runDueScheduledActions()
    .then((count) => console.log(`Processed ${count} due scheduled recovery action(s).`))
    .catch((err) => {
      console.error("Scheduled recovery worker failed:", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
