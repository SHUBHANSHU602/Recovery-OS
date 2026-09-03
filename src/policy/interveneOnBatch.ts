import "dotenv/config";
import { Pool } from "pg";
import { chooseAction } from "./chooseAction";
import { applyPolicyGate } from "./policyGate";
import { loadPolicyContext } from "./policyContext";
import { gatherEvidence } from "../evidence/gatherEvidence";
import { logAuditEvent } from "../ledger/auditLog";

const pool = new Pool();

export async function interveneOnBatch(batchName: string) {
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

    const evidence = await gatherEvidence(String(row.event_id));
    const policyContext = await loadPolicyContext(pool, {
      eventId: String(row.event_id),
      customerEmail: evidence.customerEmail,
    });

    const priorRecoveryResult = evidence.customerEmail
      ? await pool.query(
          `SELECT strategy, status, recovered_amount
           FROM recovery_cases
           WHERE customer_email = $1
             AND original_event_id <> $2
           ORDER BY updated_at DESC
           LIMIT 5`,
          [evidence.customerEmail, row.event_id]
        )
      : { rows: [] as any[] };

    const priorRecoveryOutcomes = priorRecoveryResult.rows.map((prior: any) => ({
      strategy: prior.strategy == null ? null : String(prior.strategy),
      status: String(prior.status),
      recoveredAmount: Number(prior.recovered_amount ?? 0),
    }));

    const intervention = await chooseAction({
      rootCause: String(row.root_cause),
      confidence: Number(row.confidence),
      customerFailureCount: evidence.customerFailureCount,
      amountAtRisk: evidence.amount,
      correlatedFailuresAtSameBank: evidence.correlatedFailuresAtSameBank,
      automatedRetryCount: policyContext.automatedRetryCount,
      contactsLast24h: policyContext.contactsLast24h,
      priorRecoveryOutcomes,
    });

    await logAuditEvent(row.event_id, "intervention_chosen", {
      chosen_action: intervention.chosen_action,
      reasoning: intervention.reasoning,
      decisionContext: {
        customerFailureCount: evidence.customerFailureCount,
        amountAtRisk: evidence.amount,
        correlatedFailuresAtSameBank: evidence.correlatedFailuresAtSameBank,
        automatedRetryCount: policyContext.automatedRetryCount,
        contactsLast24h: policyContext.contactsLast24h,
        priorRecoveryOutcomes,
        evidenceCutoffAt: evidence.evidenceCutoffAt,
      },
    });

    const policyOutcome = applyPolicyGate({
      chosenAction: intervention.chosen_action,
      ...policyContext,
    });

    await logAuditEvent(row.event_id, "policy_check", {
      policyContext,
      result: policyOutcome.result,
      reason: policyOutcome.reason,
      finalAction: policyOutcome.finalAction,
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

if (require.main === module) {
  interveneOnBatch("batch_1")
    .catch((err) => {
      console.error("Intervention failed:", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
