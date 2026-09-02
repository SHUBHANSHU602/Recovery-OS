import { Pool } from "pg";
import { ensureTrack3Schema } from "../recovery/recoveryStore";

export interface PolicyContextSnapshot {
  automatedRetryCount: number;
  contactsLast24h: number;
  alreadyRecovered: boolean;
  optedOut: boolean;
}

export async function loadPolicyContext(
  pool: Pool,
  input: { eventId: string; customerEmail: string }
): Promise<PolicyContextSnapshot> {
  await ensureTrack3Schema(pool);

  const retryResult = await pool.query(
    `SELECT COUNT(*)
     FROM actions a
     LEFT JOIN interventions i ON i.id = a.intervention_id
     LEFT JOIN diagnoses d ON d.id = i.diagnosis_id
     WHERE d.event_id = $1
       AND a.razorpay_api_call = 'payment_links.create'
       AND a.status IN ('pending', 'success', 'failed', 'error')`,
    [input.eventId]
  );

  const contactResult = await pool.query(
    `SELECT COUNT(*)
     FROM outbound_contacts
     WHERE customer_email = $1
       AND sent_at >= now() - interval '24 hours'`,
    [input.customerEmail]
  );

  const caseResult = await pool.query(
    `SELECT status
     FROM recovery_cases
     WHERE original_event_id = $1`,
    [input.eventId]
  );

  // No opt-out store existed in the reviewed schema. Fail closed only when an explicit
  // opt-out signal is present in an event payload; otherwise default false.
  const eventResult = await pool.query("SELECT payload FROM events WHERE event_id = $1", [input.eventId]);
  const optedOut = Boolean(eventResult.rows[0]?.payload?.customer_opted_out === true);

  return {
    automatedRetryCount: Number(retryResult.rows[0]?.count ?? 0),
    contactsLast24h: Number(contactResult.rows[0]?.count ?? 0),
    alreadyRecovered: caseResult.rows[0]?.status === "RECOVERED",
    optedOut,
  };
}
