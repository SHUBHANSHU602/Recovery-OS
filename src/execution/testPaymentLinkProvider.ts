import "dotenv/config";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { ensureTrack3Schema } from "../recovery/recoveryStore";
import { ensureRecoveryPaymentLinkSchema } from "../recovery/recoveryPaymentLinks";
import { cancelOutstandingRecoveryPaymentLinks } from "./paymentLinkProvider";

const pool = new Pool();

async function main(): Promise<void> {
  await ensureTrack3Schema(pool);
  await ensureRecoveryPaymentLinkSchema(pool);

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const eventId = `payment_link_provider_test_${suffix}`;
  const paymentLinkId = `plink_provider_test_${suffix}`;
  let caseId: number | null = null;
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];

  try {
    await pool.query(
      `INSERT INTO events(event_id, event_type, payload)
       VALUES ($1, 'payment.failed', $2)`,
      [eventId, { payload: { payment: { entity: { id: `pay_${suffix}`, email: `${suffix}@example.com`, amount: 22000 } } } }]
    );
    const caseResult = await pool.query(
      `INSERT INTO recovery_cases
         (original_event_id, original_payment_id, customer_email, amount_at_risk,
          status, financial_status, automation_status)
       VALUES ($1, $2, $3, 22000, 'RECOVERED', 'RECOVERED', 'STOPPED')
       RETURNING id`,
      [eventId, `pay_${suffix}`, `${suffix}@example.com`]
    );
    caseId = Number(caseResult.rows[0].id);
    await pool.query(
      `INSERT INTO recovery_payment_links
         (case_id, payment_link_id, short_url, status, provider_status, amount)
       VALUES ($1, $2, 'https://example.test/provider', 'SUPERSEDED', 'created', 22000)`,
      [caseId, paymentLinkId]
    );

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (url.endsWith("/cancel")) {
        return new Response(JSON.stringify({ id: paymentLinkId, status: "cancelled", amount_paid: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: paymentLinkId, status: "created", amount_paid: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const outcomes = await cancelOutstandingRecoveryPaymentLinks(pool, caseId);
    assert.deepEqual(outcomes, [{ paymentLinkId, outcome: "cancelled" }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[1].method, "POST");
    assert.ok(calls[1].url.endsWith(`/${paymentLinkId}/cancel`));

    const row = await pool.query(
      `SELECT status, provider_status, cancelled_at FROM recovery_payment_links WHERE payment_link_id = $1`,
      [paymentLinkId]
    );
    assert.equal(row.rows[0].status, "CANCELLED");
    assert.equal(row.rows[0].provider_status, "cancelled");
    assert.ok(row.rows[0].cancelled_at);

    console.log("Payment Link provider lifecycle test PASS");
    console.log("- superseded provider-created link is fetched, cancelled, and persisted as CANCELLED");
  } finally {
    globalThis.fetch = originalFetch;
    if (caseId != null) await pool.query(`DELETE FROM recovery_cases WHERE id = $1`, [caseId]);
    await pool.query(`DELETE FROM events WHERE event_id = $1`, [eventId]);
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Payment Link provider lifecycle test FAILED:", error);
  process.exitCode = 1;
});
