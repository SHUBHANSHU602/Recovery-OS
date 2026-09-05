import "dotenv/config";
import { Pool } from "pg";
import { gatherEvidence } from "../evidence/gatherEvidence";
import { diagnose } from "../diagnosis/diagnose";
import { verify } from "../verifier/verify";
import { chooseAction } from "../policy/chooseAction";
import { applyPolicyGate } from "../policy/policyGate";
import { loadPolicyContext } from "../policy/policyContext";
import { executeAction } from "../execution/execute";
import { logAuditEvent } from "../ledger/auditLog";
import { refreshRecoveryPriority } from "../intelligence/recoveryIntelligence";
import { ensureRecoveryCase, ensureTrack3Schema, setRecoveryState } from "./recoveryStore";

const pool = new Pool();
const STALE_JOB_MINUTES = 5;

export async function processRecoveryCase(eventId: string): Promise<void> {
  await ensureTrack3Schema(pool);
  const caseId = await ensureRecoveryCase(pool, eventId);
  if (!caseId) throw new Error(`Cannot create recovery case for ${eventId}`);

  const claimed = await pool.query(
    `UPDATE recovery_jobs
     SET status = 'RUNNING', claimed_at = now(), attempt_count = attempt_count + 1, updated_at = now()
     WHERE case_id = $1
       AND (
         status IN ('PENDING', 'FAILED')
         OR (status = 'RUNNING' AND claimed_at < now() - ($2 * interval '1 minute'))
       )
     RETURNING case_id`,
    [caseId, STALE_JOB_MINUTES]
  );
  if (claimed.rows.length === 0) return;

  try {
    const existingCase = await pool.query("SELECT status FROM recovery_cases WHERE id = $1", [caseId]);
    if (["RECOVERED", "STOPPED", "ESCALATED"].includes(existingCase.rows[0]?.status)) {
      await pool.query("UPDATE recovery_jobs SET status = 'DONE', updated_at = now() WHERE case_id = $1", [caseId]);
      return;
    }

    const evidence = await gatherEvidence(eventId);
    await setRecoveryState(pool, caseId, "EVIDENCE_READY", { evidenceCutoffAt: new Date(evidence.evidenceCutoffAt) });
    await logAuditEvent(eventId, "evidence_snapshot", evidence);

    let diagnosisRow = await pool.query("SELECT id, root_cause, confidence FROM diagnoses WHERE event_id = $1 ORDER BY id DESC LIMIT 1", [eventId]);
    if (diagnosisRow.rows.length === 0) {
      const modelDiagnosis = await diagnose(evidence);
      await setRecoveryState(pool, caseId, "DIAGNOSED");
      await logAuditEvent(eventId, "diagnosis", modelDiagnosis);
      const verification = verify(modelDiagnosis, evidence);
      await setRecoveryState(pool, caseId, "VERIFIED");
      await logAuditEvent(eventId, "verification", verification);
      diagnosisRow = await pool.query(
        `INSERT INTO diagnoses (event_id, root_cause, rationale, confidence, verifier_result)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, root_cause, confidence`,
        [eventId, verification.finalRootCause, modelDiagnosis.rationale, modelDiagnosis.confidence, verification.result]
      );
    }

    const diagnosis = diagnosisRow.rows[0];
    let interventionRow = await pool.query(
      "SELECT id, chosen_action, final_action FROM interventions WHERE diagnosis_id = $1 ORDER BY id DESC LIMIT 1",
      [diagnosis.id]
    );

    if (interventionRow.rows.length === 0) {
      const eventResult = await pool.query("SELECT payload FROM events WHERE event_id = $1", [eventId]);
      const payment = eventResult.rows[0].payload.payload.payment.entity;
      const customerEmail = String(payment.email ?? "");
      const policyContext = await loadPolicyContext(pool, { eventId, customerEmail });
      const priorRecoveryResult = customerEmail
        ? await pool.query(
            `SELECT strategy, status, recovered_amount
             FROM recovery_cases
             WHERE customer_email = $1
               AND original_event_id <> $2
             ORDER BY updated_at DESC
             LIMIT 5`,
            [customerEmail, eventId]
          )
        : { rows: [] as any[] };

      const chosen = await chooseAction({
        rootCause: diagnosis.root_cause,
        confidence: Number(diagnosis.confidence),
        customerFailureCount: evidence.customerFailureCount,
        amountAtRisk: evidence.amount,
        correlatedFailuresAtSameBank: evidence.correlatedFailuresAtSameBank,
        automatedRetryCount: policyContext.automatedRetryCount,
        contactsLast24h: policyContext.contactsLast24h,
        priorRecoveryOutcomes: priorRecoveryResult.rows.map((row: any) => ({
          strategy: row.strategy == null ? null : String(row.strategy),
          status: String(row.status),
          recoveredAmount: Number(row.recovered_amount ?? 0),
        })),
      });
      await setRecoveryState(pool, caseId, "ACTION_CHOSEN", { strategy: chosen.chosen_action });
      const policy = applyPolicyGate({ chosenAction: chosen.chosen_action, ...policyContext });
      await setRecoveryState(pool, caseId, policy.result === "APPROVED" ? "POLICY_APPROVED" : "POLICY_BLOCKED", {
        terminalReason: policy.result === "APPROVED" ? undefined : policy.reason,
      });
      await logAuditEvent(eventId, "policy_check", {
        chosen,
        policyContext,
        policy,
        decisionContext: {
          customerFailureCount: evidence.customerFailureCount,
          amountAtRisk: evidence.amount,
          correlatedFailuresAtSameBank: evidence.correlatedFailuresAtSameBank,
          priorRecoveryOutcomes: priorRecoveryResult.rows,
        },
      });
      interventionRow = await pool.query(
        `INSERT INTO interventions (diagnosis_id, chosen_action, reasoning, policy_check_result, final_action)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, chosen_action, final_action`,
        [diagnosis.id, chosen.chosen_action, chosen.reasoning, policy.result, policy.finalAction]
      );
    }

    const intervention = interventionRow.rows[0];
    const priority = await refreshRecoveryPriority(pool, caseId, String(intervention.chosen_action));
    await logAuditEvent(eventId, "recovery_priority_scored", priority);

    const eventResult = await pool.query("SELECT payload FROM events WHERE event_id = $1", [eventId]);
    const payment = eventResult.rows[0].payload.payload.payment.entity;
    await executeAction({
      eventId,
      interventionId: Number(intervention.id),
      finalAction: intervention.final_action,
      amount: Number(payment.amount),
      customerEmail: String(payment.email ?? ""),
    });

    await pool.query("UPDATE recovery_jobs SET status = 'DONE', last_error = NULL, updated_at = now() WHERE case_id = $1", [caseId]);
  } catch (error: any) {
    await pool.query(
      "UPDATE recovery_jobs SET status = 'FAILED', last_error = $2, updated_at = now() WHERE case_id = $1",
      [caseId, error.message]
    );
    await logAuditEvent(eventId, "recovery_pipeline_error", { error: error.message });
    throw error;
  }
}

export async function processPendingRecoveryJobs(limit = 10): Promise<void> {
  await ensureTrack3Schema(pool);
  const jobs = await pool.query(
    `SELECT rc.original_event_id
     FROM recovery_jobs j
     JOIN recovery_cases rc ON rc.id = j.case_id
     WHERE j.status IN ('PENDING', 'FAILED')
        OR (j.status = 'RUNNING' AND j.claimed_at < now() - ($2 * interval '1 minute'))
     ORDER BY j.updated_at ASC
     LIMIT $1`,
    [limit, STALE_JOB_MINUTES]
  );
  for (const row of jobs.rows) await processRecoveryCase(row.original_event_id);
}
