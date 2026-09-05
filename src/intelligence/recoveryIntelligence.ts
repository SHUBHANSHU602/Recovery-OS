import type { Pool } from "pg";

export interface ContactWindowConfig {
  timeZone: string;
  quietStartHour: number;
  quietEndHour: number;
}

export const DEFAULT_CONTACT_WINDOW: ContactWindowConfig = {
  timeZone: process.env.RECOVERY_TIMEZONE || "Asia/Kolkata",
  quietStartHour: Number(process.env.RECOVERY_QUIET_HOURS_START ?? 21),
  quietEndHour: Number(process.env.RECOVERY_QUIET_HOURS_END ?? 8),
};

export const CAUSE_AWARE_INITIAL_DELAY_SECONDS: Record<string, number> = {
  systemic_bank_outage: 30 * 60,
  insufficient_funds: 6 * 60 * 60,
  expired_card: 12 * 60 * 60,
  ambiguous: 60 * 60,
};

const ROOT_CAUSE_PRIOR: Record<string, number> = {
  systemic_bank_outage: 0.7,
  expired_card: 0.55,
  insufficient_funds: 0.35,
  ambiguous: 0.15,
};

const PRIOR_WEIGHT = 4;

function clampProbability(value: number): number {
  return Math.max(0.05, Math.min(0.95, value));
}

function zonedHour(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  });
  return Number(formatter.format(date));
}

export function isQuietHours(date: Date, config: ContactWindowConfig = DEFAULT_CONTACT_WINDOW): boolean {
  const { quietStartHour: start, quietEndHour: end, timeZone } = config;
  if (start === end) return false;
  const hour = zonedHour(date, timeZone);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function nextAllowedContactTime(date: Date, config: ContactWindowConfig = DEFAULT_CONTACT_WINDOW): Date {
  if (!isQuietHours(date, config)) return new Date(date);

  const candidate = new Date(date);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // A valid daily contact window must appear within 24h. Keep a little headroom for DST zones.
  for (let minute = 0; minute < 36 * 60; minute += 1) {
    if (!isQuietHours(candidate, config)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error("Unable to find the next allowed contact window");
}

export function causeAwareInitialDelaySeconds(rootCause: string | null | undefined): number {
  return CAUSE_AWARE_INITIAL_DELAY_SECONDS[rootCause ?? ""] ?? 5 * 60;
}

export function estimateRecoveryProbability(input: {
  rootCause: string | null | undefined;
  historicalCases: number;
  historicalRecoveries: number;
}): number {
  const prior = ROOT_CAUSE_PRIOR[input.rootCause ?? ""] ?? 0.3;
  const cases = Math.max(0, Math.floor(input.historicalCases));
  const recoveries = Math.max(0, Math.min(cases, Math.floor(input.historicalRecoveries)));
  return clampProbability((prior * PRIOR_WEIGHT + recoveries) / (PRIOR_WEIGHT + cases));
}

export function expectedRecoveryValue(amountAtRisk: number, probability: number): number {
  return Math.max(0, Math.round(Math.max(0, amountAtRisk) * clampProbability(probability)));
}

export async function refreshRecoveryPriority(
  pool: Pool,
  caseId: number,
  strategyOverride?: string | null
): Promise<{ recoveryProbability: number; expectedRecoveryValue: number; rootCause: string | null; strategy: string | null }> {
  const current = await pool.query(
    `SELECT rc.amount_at_risk, rc.strategy,
            d.root_cause
     FROM recovery_cases rc
     LEFT JOIN LATERAL (
       SELECT root_cause
       FROM diagnoses
       WHERE event_id = rc.original_event_id
       ORDER BY id DESC
       LIMIT 1
     ) d ON true
     WHERE rc.id = $1`,
    [caseId]
  );
  if (current.rows.length === 0) throw new Error(`Recovery case ${caseId} does not exist`);

  const rootCause = current.rows[0].root_cause == null ? null : String(current.rows[0].root_cause);
  const strategy = strategyOverride ?? (current.rows[0].strategy == null ? null : String(current.rows[0].strategy));
  const amountAtRisk = Number(current.rows[0].amount_at_risk ?? 0);

  const history = await pool.query(
    `WITH latest_diagnosis AS (
       SELECT DISTINCT ON (event_id) event_id, root_cause
       FROM diagnoses
       ORDER BY event_id, id DESC
     )
     SELECT
       COUNT(*) AS cases,
       COUNT(*) FILTER (
         WHERE rc.status = 'RECOVERED'
           AND rc.recovered_amount > 0
           AND rc.recovered_at IS NOT NULL
           AND rc.razorpay_payment_link_id IS NOT NULL
           AND rc.terminal_reason = 'trusted_payment_link_paid'
       ) AS recoveries
     FROM recovery_cases rc
     JOIN latest_diagnosis d ON d.event_id = rc.original_event_id
     WHERE rc.id <> $1
       AND d.root_cause IS NOT DISTINCT FROM $2::text
       AND ($3::text IS NULL OR rc.strategy = $3)
       AND rc.status IN ('RECOVERED', 'STOPPED', 'ESCALATED')`,
    [caseId, rootCause, strategy]
  );

  const recoveryProbability = estimateRecoveryProbability({
    rootCause,
    historicalCases: Number(history.rows[0]?.cases ?? 0),
    historicalRecoveries: Number(history.rows[0]?.recoveries ?? 0),
  });
  const expectedValue = expectedRecoveryValue(amountAtRisk, recoveryProbability);

  await pool.query(
    `UPDATE recovery_cases
     SET recovery_probability = $2,
         expected_recovery_value = $3,
         priority_updated_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [caseId, recoveryProbability, expectedValue]
  );

  return { recoveryProbability, expectedRecoveryValue: expectedValue, rootCause, strategy };
}

export async function refreshMissingOpenRecoveryPriorities(pool: Pool, limit = 100): Promise<number> {
  const result = await pool.query(
    `SELECT id, strategy
     FROM recovery_cases
     WHERE status NOT IN ('RECOVERED', 'STOPPED', 'ESCALATED')
       AND (recovery_probability IS NULL OR expected_recovery_value IS NULL)
     ORDER BY updated_at ASC
     LIMIT $1`,
    [Math.min(500, Math.max(1, limit))]
  );

  for (const row of result.rows) {
    await refreshRecoveryPriority(
      pool,
      Number(row.id),
      row.strategy == null ? null : String(row.strategy)
    );
  }

  return result.rows.length;
}
