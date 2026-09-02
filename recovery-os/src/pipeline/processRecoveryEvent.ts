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
  const evidence = await gatherEvidence(eventId);

  let diagnosisId: number;
  let rootCause: string;
  let confidence: number;

  const existingDiagnosis = await pool.query(
    "SELECT id, root_cause, confidence FROM diagnoses WHERE event_id = $1 ORDER BY id LIMIT 1",
    [eventId]
  );

  if (existingDiagnosis.rows.length === 0) {
    const diagnosis = await diagnose(evidence);
    await logAuditEvent(eventId, "diagnosis", diagnosis);

    const verification = verify(diagnosis, evidence);
    await logAuditEvent(eventId, "verification", verification);

    const inserted = await pool.query(
      `INSERT INTO diagnoses (event_id, root_cause, rationale, confidence, verifier_result)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [eventId, verification.finalRootCause, diagnosis.rationale, diagnosis.confidence, verification.result]
    );

    diagnosisId = inserted.rows[0].id;
    rootCause = verification.finalRootCause;
    confidence = diagnosis.confidence;
  } else {
    diagnosisId = existingDiagnosis.rows[0].id;
    rootCause = existingDiagnosis.rows[0].root_cause;
    confidence = Number(existingDiagnosis.rows[0].confidence);
    await logAuditEvent(eventId, "pipeline_resumed_after_diagnosis", { diagnosisId });
  }

  let interventionId: number;
  let finalAction: string;

  const existingIntervention = await pool.query(
    "SELECT id, final_action FROM interventions WHERE diagnosis_id = $1 ORDER BY id LIMIT 1",
    [diagnosisId]
  );

  if (existingIntervention.rows.length === 0) {
    const runtime = await getPolicyRuntimeContext(eventId);
    const intervention = await chooseAction({
      rootCause,
      confidence,
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

    const inserted = await pool.query(
      `INSERT INTO interventions (diagnosis_id, chosen_action, reasoning, policy_check_result, final_action)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [diagnosisId, intervention.chosen_action, intervention.reasoning, policy.result, policy.finalAction]
    );

    interventionId = inserted.rows[0].id;
    finalAction = policy.finalAction;
  } else {
    interventionId = existingIntervention.rows[0].id;
    finalAction = existingIntervention.rows[0].final_action;
    await logAuditEvent(eventId, "pipeline_resumed_after_intervention", { interventionId, finalAction });
  }

  await executeAction({
    eventId,
    interventionId,
    finalAction,
    amount: evidence.amount,
    customerEmail: evidence.customerEmail,
  });
}
