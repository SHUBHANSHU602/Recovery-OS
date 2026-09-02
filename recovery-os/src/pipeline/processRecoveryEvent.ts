import "dotenv/config";
import { Pool } from "pg";
import { gatherEvidence } from "../evidence/gatherEvidence";
import { diagnose } from "../diagnosis/diagnose";
import { verify } from "../verifier/verify";
import { chooseAction } from "../policy/chooseAction";
import { getPolicyRuntimeContext } from "../policy/policyContext";
import { applyPolicyGate } from "../policy/policyGate";
import { executeAction } from "../execution/execute";
import { logAuditEvent } from "../ledger/auditLog";

const pool = new Pool();

export async function processRecoveryEvent(eventId: string): Promise<void> {
  const existing = await pool.query("SELECT id FROM diagnoses WHERE event_id = $1 LIMIT 1", [eventId]);
  if (existing.rows.length > 0) {
    await logAuditEvent(eventId, "pipeline_skipped_already_processed", {});
    return;
  }

  const evidence = await gatherEvidence(eventId);
  const diagnosis = await diagnose(evidence);
  await logAuditEvent(eventId, "diagnosis", diagnosis);

  const verification = verify(diagnosis, evidence);
  await logAuditEvent(eventId, "verification", verification);

  const diagnosisInsert = await pool.query(
    `INSERT INTO diagnoses (event_id, root_cause, rationale, confidence, verifier_result)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [eventId, verification.finalRootCause, diagnosis.rationale, diagnosis.confidence, verification.result]
  );
  const diagnosisId = diagnosisInsert.rows[0].id as number;

  const runtime = await getPolicyRuntimeContext(eventId);
  const intervention = await chooseAction({
    rootCause: verification.finalRootCause,
    confidence: diagnosis.confidence,
    customerFailureCount: runtime.customerFailureCount,
  });
  await logAuditEvent(eventId, "intervention_chosen", intervention);

  const policy = applyPolicyGate({
    chosenAction: intervention.chosen_action,
    automatedRecoveryAttemptCount: runtime.automatedRecoveryAttemptCount,
    customerContactedInLast24h: runtime.customerContactedInLast24h,
    paymentAlreadyRecovered: runtime.paymentAlreadyRecovered,
  });
  await logAuditEvent(eventId, "policy_check", { ...policy, runtime });

  const interventionInsert = await pool.query(
    `INSERT INTO interventions (diagnosis_id, chosen_action, reasoning, policy_check_result, final_action)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [diagnosisId, intervention.chosen_action, intervention.reasoning, policy.result, policy.finalAction]
  );

  await executeAction({
    eventId,
    interventionId: interventionInsert.rows[0].id,
    finalAction: policy.finalAction,
    amount: evidence.amount,
    customerEmail: evidence.customerEmail,
  });
}
