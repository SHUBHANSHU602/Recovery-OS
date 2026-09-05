import type { Pool } from "pg";
import type { Action } from "../policy/chooseAction";
import type { PolicyOutcome } from "../policy/policyGate";
import type {
  PersistedPlanSummary,
  RecoveryPlan,
  RecoveryPlanTrigger,
  StrategyEvidence,
} from "./recoveryPlanner";

export async function loadStrategyEvidence(
  pool: Pool,
  input: { caseId: number; rootCause: string }
): Promise<StrategyEvidence[]> {
  const result = await pool.query(
    `WITH latest_diagnosis AS (
       SELECT DISTINCT ON (event_id) event_id, root_cause
       FROM diagnoses
       ORDER BY event_id, id DESC
     )
     SELECT
       COALESCE(rc.strategy, 'unassigned') AS strategy,
       COUNT(*) AS cases,
       COUNT(*) FILTER (
         WHERE rc.status = 'RECOVERED'
           AND rc.recovered_amount > 0
           AND rc.recovered_at IS NOT NULL
           AND rc.razorpay_payment_link_id IS NOT NULL
           AND rc.terminal_reason = 'trusted_payment_link_paid'
       ) AS recoveries,
       COALESCE(SUM(
         CASE
           WHEN rc.status = 'RECOVERED'
             AND rc.recovered_amount > 0
             AND rc.recovered_at IS NOT NULL
             AND rc.razorpay_payment_link_id IS NOT NULL
             AND rc.terminal_reason = 'trusted_payment_link_paid'
           THEN LEAST(rc.amount_at_risk, rc.recovered_amount)
           ELSE 0
         END
       ), 0) AS recovered_amount
     FROM recovery_cases rc
     JOIN latest_diagnosis d ON d.event_id = rc.original_event_id
     WHERE rc.id <> $1
       AND d.root_cause = $2
       AND rc.status IN ('RECOVERED', 'STOPPED', 'ESCALATED')
     GROUP BY COALESCE(rc.strategy, 'unassigned')
     ORDER BY recoveries DESC, cases DESC, strategy ASC`,
    [input.caseId, input.rootCause]
  );

  return result.rows.map((row) => {
    const cases = Number(row.cases ?? 0);
    const recoveries = Number(row.recoveries ?? 0);
    return {
      strategy: String(row.strategy),
      cases,
      recoveries,
      recoveryRate: cases > 0 ? (recoveries / cases) * 100 : 0,
      recoveredAmount: Number(row.recovered_amount ?? 0),
    };
  });
}

export async function loadLatestRecoveryPlan(pool: Pool, caseId: number): Promise<PersistedPlanSummary | null> {
  const result = await pool.query(
    `SELECT version, trigger, objective, primary_action, fallback_action, reasoning
     FROM recovery_plans
     WHERE case_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [caseId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    version: Number(row.version),
    trigger: String(row.trigger),
    objective: String(row.objective),
    primaryAction: String(row.primary_action) as Action,
    fallbackAction: String(row.fallback_action) as Action,
    reasoning: String(row.reasoning),
  };
}

export async function persistRecoveryPlan(
  pool: Pool,
  input: {
    caseId: number;
    eventId: string;
    trigger: RecoveryPlanTrigger;
    plan: RecoveryPlan;
    strategyEvidence: StrategyEvidence[];
    observation?: Record<string, unknown> | null;
    policy: PolicyOutcome;
  }
): Promise<{ id: number; version: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [input.caseId]);
    const versionResult = await client.query(
      "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM recovery_plans WHERE case_id = $1",
      [input.caseId]
    );
    const version = Number(versionResult.rows[0].version);
    const inserted = await client.query(
      `INSERT INTO recovery_plans
         (case_id, event_id, version, trigger, objective, primary_action, fallback_action,
          reasoning, escalation_criteria, stop_conditions, strategy_evidence, observation,
          policy_result, policy_final_action)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        input.caseId,
        input.eventId,
        version,
        input.trigger,
        input.plan.objective,
        input.plan.primary_action,
        input.plan.fallback_action,
        input.plan.reasoning,
        JSON.stringify(input.plan.escalation_criteria),
        JSON.stringify(input.plan.stop_conditions),
        JSON.stringify(input.strategyEvidence),
        input.observation ? JSON.stringify(input.observation) : null,
        input.policy.result,
        input.policy.finalAction,
      ]
    );
    await client.query("COMMIT");
    return { id: Number(inserted.rows[0].id), version };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
