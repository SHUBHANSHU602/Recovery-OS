import type { Pool } from "pg";
import type { RecoveryPlanTrigger } from "../agent/recoveryPlanner";

const DEFAULT_REVIEW_SECONDS = Number(process.env.AI_OUTCOME_REVIEW_SECONDS ?? 6 * 60 * 60);

export async function queueRecoveryReplan(
  pool: Pool,
  input: {
    caseId: number;
    eventId: string;
    trigger: Exclude<RecoveryPlanTrigger, "initial_failure">;
    observation?: Record<string, unknown> | null;
  }
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE recovery_jobs j
     SET status = 'PENDING',
         mode = 'REPLAN',
         replan_trigger = $3,
         replan_observation = $4,
         claimed_at = NULL,
         last_error = NULL,
         updated_at = now()
     FROM recovery_cases rc
     WHERE j.case_id = $1
       AND rc.id = j.case_id
       AND rc.original_event_id = $2
       AND rc.status NOT IN ('RECOVERED', 'STOPPED', 'ESCALATED')
     RETURNING j.case_id`,
    [input.caseId, input.eventId, input.trigger, input.observation ? JSON.stringify(input.observation) : null]
  );
  return result.rows.length === 1;
}

export async function scheduleBusinessOutcomeReview(
  pool: Pool,
  input: {
    caseId: number;
    eventId: string;
    interventionId?: number | null;
    action: string;
    delaySeconds?: number;
  }
): Promise<void> {
  const delaySeconds = Math.max(1, Math.floor(input.delaySeconds ?? DEFAULT_REVIEW_SECONDS));
  const sequence = await pool.query(
    `SELECT COUNT(*) AS count
     FROM scheduled_actions
     WHERE case_id = $1 AND desired_action = 'ai_outcome_review'`,
    [input.caseId]
  );
  const number = Number(sequence.rows[0]?.count ?? 0) + 1;
  const key = `${input.eventId}_ai_outcome_review_${number}`;
  await pool.query(
    `INSERT INTO scheduled_actions
       (case_id, event_id, intervention_id, desired_action, schedule_key, run_at, status, last_error)
     VALUES ($1, $2, $3, 'ai_outcome_review', $4, now() + ($5 * interval '1 second'), 'PENDING', $6)
     ON CONFLICT (schedule_key) DO NOTHING`,
    [input.caseId, input.eventId, input.interventionId ?? null, key, delaySeconds, `prior_action=${input.action}`]
  );
}
