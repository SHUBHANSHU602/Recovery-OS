import "dotenv/config";
import assert from "node:assert/strict";
import { Pool } from "pg";

type LinkRow = {
  action_id: string;
  idempotency_key: string;
  payment_link_id: string;
  short_url: string | null;
  case_id: string | null;
  case_status: string | null;
  amount_at_risk: string | null;
  recovered_amount: string | null;
  razorpay_payment_link_id: string | null;
  terminal_reason: string | null;
};

type ProviderLink = {
  id: string;
  status: string;
  amount: number;
  amount_paid: number;
  short_url?: string | null;
};

function rupees(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

async function loadProviderCreatedLinks(pool: Pool): Promise<LinkRow[]> {
  const result = await pool.query(`
    SELECT
      a.id AS action_id,
      a.idempotency_key,
      a.response->>'id' AS payment_link_id,
      a.response->>'short_url' AS short_url,
      COALESCE(rc_by_link.id, rc_by_intervention.id, rc_by_prefix.id) AS case_id,
      COALESCE(rc_by_link.status, rc_by_intervention.status, rc_by_prefix.status) AS case_status,
      COALESCE(rc_by_link.amount_at_risk, rc_by_intervention.amount_at_risk, rc_by_prefix.amount_at_risk) AS amount_at_risk,
      COALESCE(rc_by_link.recovered_amount, rc_by_intervention.recovered_amount, rc_by_prefix.recovered_amount) AS recovered_amount,
      COALESCE(rc_by_link.razorpay_payment_link_id, rc_by_intervention.razorpay_payment_link_id, rc_by_prefix.razorpay_payment_link_id) AS razorpay_payment_link_id,
      COALESCE(rc_by_link.terminal_reason, rc_by_intervention.terminal_reason, rc_by_prefix.terminal_reason) AS terminal_reason
    FROM actions a
    LEFT JOIN interventions i ON i.id = a.intervention_id
    LEFT JOIN diagnoses d ON d.id = i.diagnosis_id
    LEFT JOIN recovery_cases rc_by_link
      ON rc_by_link.razorpay_payment_link_id = a.response->>'id'
    LEFT JOIN recovery_cases rc_by_intervention
      ON rc_by_intervention.original_event_id = d.event_id
    LEFT JOIN LATERAL (
      SELECT e.event_id
      FROM events e
      WHERE a.idempotency_key LIKE e.event_id || '%'
      ORDER BY length(e.event_id) DESC
      LIMIT 1
    ) matched ON true
    LEFT JOIN recovery_cases rc_by_prefix
      ON rc_by_prefix.original_event_id = matched.event_id
    WHERE a.razorpay_api_call = 'payment_links.create'
      AND a.status = 'success'
      AND a.response->>'id' IS NOT NULL
    ORDER BY a.id ASC
  `);

  return result.rows as LinkRow[];
}

async function fetchProviderLink(linkId: string, auth: string): Promise<ProviderLink> {
  const response = await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(linkId)}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    const reason = body?.error?.description ?? body?.error?.reason ?? `HTTP ${response.status}`;
    throw new Error(`Razorpay lookup failed for ${linkId}: ${reason}`);
  }
  return {
    id: String(body.id),
    status: String(body.status),
    amount: Number(body.amount ?? 0),
    amount_paid: Number(body.amount_paid ?? 0),
    short_url: body.short_url == null ? null : String(body.short_url),
  };
}

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  assert.ok(keyId && keySecret, "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required for provider reconciliation");

  const pool = new Pool();
  try {
    const rows = await loadProviderCreatedLinks(pool);
    assert.ok(rows.length > 0, "No successful Razorpay Payment Link creations were found in the local ledger");

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    let providerPaid = 0;
    let providerUnpaid = 0;
    let paidCorrect = 0;
    let unpaidCorrect = 0;
    let providerBackedRecoveredPaise = 0;
    const mismatches: string[] = [];

    console.log("\nRecovery OS — Razorpay provider reconciliation\n");
    console.log("link_id | provider | amount_paid | case | case_status | recovered_amount | verdict");

    for (const row of rows) {
      const provider = await fetchProviderLink(row.payment_link_id, auth);
      const caseId = row.case_id == null ? null : Number(row.case_id);
      const recoveredAmount = Number(row.recovered_amount ?? 0);
      const currentCaseLink = row.razorpay_payment_link_id;
      let verdict = "PASS";

      if (provider.status === "paid" && provider.amount_paid > 0) {
        providerPaid += 1;
        const expectedRecovered = Math.min(Number(row.amount_at_risk ?? provider.amount_paid), provider.amount_paid);
        const valid =
          caseId != null &&
          row.case_status === "RECOVERED" &&
          recoveredAmount === expectedRecovered &&
          row.terminal_reason === "trusted_payment_link_paid" &&
          currentCaseLink === provider.id;

        if (valid) {
          paidCorrect += 1;
          providerBackedRecoveredPaise += recoveredAmount;
        } else {
          verdict = "MISMATCH";
          mismatches.push(
            `${provider.id}: provider is paid (${provider.amount_paid}) but ledger case=${caseId ?? "none"}, status=${row.case_status ?? "none"}, recovered=${recoveredAmount}, terminal=${row.terminal_reason ?? "none"}, currentLink=${currentCaseLink ?? "none"}`
          );
        }
      } else {
        providerUnpaid += 1;
        const falselyAttributedToThisLink =
          row.case_status === "RECOVERED" &&
          currentCaseLink === provider.id &&
          recoveredAmount > 0;

        if (!falselyAttributedToThisLink) {
          unpaidCorrect += 1;
        } else {
          verdict = "MISMATCH";
          mismatches.push(
            `${provider.id}: provider status=${provider.status}, amount_paid=${provider.amount_paid}, but the ledger attributes a positive recovery to this link`
          );
        }
      }

      console.log(
        `${provider.id} | ${provider.status} | ${rupees(provider.amount_paid)} | ${caseId ?? "-"} | ${row.case_status ?? "-"} | ${rupees(recoveredAmount)} | ${verdict}`
      );
    }

    console.log("\nSummary");
    console.log(`Provider links checked: ${rows.length}`);
    console.log(`Provider-paid links: ${providerPaid}`);
    console.log(`Provider-unpaid links: ${providerUnpaid}`);
    console.log(`Paid links correctly reconciled: ${paidCorrect}/${providerPaid}`);
    console.log(`Unpaid links not falsely attributed to recovered revenue: ${unpaidCorrect}/${providerUnpaid}`);
    console.log(`Provider-backed recovered amount: ${rupees(providerBackedRecoveredPaise)}`);
    console.log(`Mismatches: ${mismatches.length}`);

    if (mismatches.length > 0) {
      console.error("\nReconciliation mismatches:");
      for (const mismatch of mismatches) console.error(`- ${mismatch}`);
      throw new Error("Provider reconciliation FAILED");
    }

    assert.equal(paidCorrect, providerPaid, "Every provider-paid link must reconcile to trusted recovered accounting");
    assert.equal(unpaidCorrect, providerUnpaid, "No provider-unpaid link may be falsely attributed to recovered revenue");
    console.log("\nPROVIDER RECONCILIATION RESULT: PASS");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
