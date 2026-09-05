import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildRecoveryMessage, getChannelProviderStatus, sendRecoveryChannel } from "./channelService";
import { ensureRecoveryCase, ensureTrack3Schema } from "../recovery/recoveryStore";

const message = buildRecoveryMessage({
  amountAtRisk: 70351,
  rootCause: "systemic_bank_outage",
  paymentLinkUrl: "https://example.test/pay",
});

assert.match(message, /₹703\.51/);
assert.match(message, /systemic bank outage/);
assert.match(message, /https:\/\/example\.test\/pay/);

for (const key of [
  "RESEND_API_KEY",
  "RECOVERY_EMAIL_FROM",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_SMS_FROM",
  "TWILIO_WHATSAPP_FROM",
  "TWILIO_VOICE_FROM",
]) delete process.env[key];

const providers = getChannelProviderStatus();
assert.deepEqual(providers.map((item) => item.channel), ["email", "sms", "whatsapp", "voice"]);
for (const provider of providers) {
  assert.equal(provider.provider, "simulated");
  assert.equal(provider.live, false);
  assert.ok(provider.reason.length > 0);
}

async function main() {
  const pool = new Pool();
  const eventId = `phase_c_test_${randomUUID()}`;
  const paymentId = `pay_phase_c_${randomUUID()}`;
  const customerEmail = `phase-c-${randomUUID()}@example.com`;
  const actionKey = `${eventId}_retry_now_attempt_1`;

  try {
    await ensureTrack3Schema(pool);
    await pool.query(
      `INSERT INTO events (event_id, event_type, payload)
       VALUES ($1, 'payment.failed', $2)`,
      [eventId, {
        event: "payment.failed",
        payload: { payment: { entity: {
          id: paymentId,
          amount: 70351,
          currency: "INR",
          email: customerEmail,
          contact: "+919999999999",
          bank: "HDFC",
          error_code: "GATEWAY_ERROR",
          error_description: "Payment authorization timed out",
          created_at: Math.floor(Date.now() / 1000) - 60,
        } } },
      }]
    );

    const caseId = await ensureRecoveryCase(pool, eventId);
    assert.ok(caseId);
    await pool.query(
      `INSERT INTO diagnoses (event_id, root_cause, rationale, confidence, verifier_result)
       VALUES ($1, 'systemic_bank_outage', 'test', 0.9, 'PASSED')`,
      [eventId]
    );
    await pool.query(
      `INSERT INTO actions (intervention_id, razorpay_api_call, idempotency_key, status, response)
       VALUES (NULL, 'payment_links.create', $1, 'success', $2)`,
      [actionKey, { id: "plink_phase_c_test", short_url: "https://rzp.io/i/test-recovery" }]
    );

    const allowedNow = new Date("2026-09-05T12:00:00.000Z");
    const delivered = await sendRecoveryChannel(pool, {
      caseId: Number(caseId),
      channel: "email",
      now: allowedNow,
    });
    assert.equal(delivered.status, "SIMULATED");
    assert.match(delivered.message, /https:\/\/rzp\.io\/i\/test-recovery/);

    await pool.query("DELETE FROM channel_deliveries WHERE case_id = $1", [caseId]);
    await pool.query("DELETE FROM outbound_contacts WHERE case_id = $1", [caseId]);

    const concurrent = await Promise.allSettled([
      sendRecoveryChannel(pool, { caseId: Number(caseId), channel: "email", now: allowedNow, message: "attempt one" }),
      sendRecoveryChannel(pool, { caseId: Number(caseId), channel: "email", now: allowedNow, message: "attempt two" }),
    ]);
    assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((item) => item.status === "rejected").length, 1);

    const contactCount = await pool.query(
      `SELECT COUNT(*) FROM outbound_contacts WHERE customer_email = $1`,
      [customerEmail]
    );
    assert.equal(Number(contactCount.rows[0].count), 1);

    await assert.rejects(
      () => sendRecoveryChannel(pool, {
        caseId: Number(caseId),
        channel: "email",
        now: new Date("2026-09-05T18:00:00.000Z"),
      }),
      /Quiet-hours policy blocks manual channel delivery/
    );

    console.log("Channel adapter and DB-backed delivery tests passed.");
  } finally {
    await pool.query("DELETE FROM channel_deliveries WHERE event_id = $1", [eventId]).catch(() => undefined);
    await pool.query("DELETE FROM outbound_contacts WHERE case_id IN (SELECT id FROM recovery_cases WHERE original_event_id = $1)", [eventId]).catch(() => undefined);
    await pool.query("DELETE FROM actions WHERE idempotency_key = $1", [actionKey]).catch(() => undefined);
    await pool.query("DELETE FROM recovery_cases WHERE original_event_id = $1", [eventId]).catch(() => undefined);
    await pool.query("DELETE FROM events WHERE event_id = $1", [eventId]).catch(() => undefined);
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Channel tests failed:", error);
  process.exitCode = 1;
});
