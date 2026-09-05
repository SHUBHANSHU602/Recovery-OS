import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { POLICY_LIMITS } from "../policy/policyGate";
import { isQuietHours, nextAllowedContactTime } from "../intelligence/recoveryIntelligence";

export type RecoveryChannel = "email" | "sms" | "whatsapp" | "voice";

export interface ChannelSendInput {
  caseId: number;
  channel: RecoveryChannel;
  message?: string | null;
  now?: Date;
}

export interface ChannelProviderStatus {
  channel: RecoveryChannel;
  provider: "resend" | "twilio" | "simulated";
  live: boolean;
  reason: string;
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getChannelProviderStatus(): ChannelProviderStatus[] {
  const resend = Boolean(env("RESEND_API_KEY") && env("RECOVERY_EMAIL_FROM"));
  const twilioBase = Boolean(env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN"));
  const sms = Boolean(twilioBase && env("TWILIO_SMS_FROM"));
  const whatsapp = Boolean(twilioBase && env("TWILIO_WHATSAPP_FROM"));
  const voice = Boolean(twilioBase && env("TWILIO_VOICE_FROM"));

  return [
    { channel: "email", provider: resend ? "resend" : "simulated", live: resend, reason: resend ? "Resend credentials configured" : "Set RESEND_API_KEY and RECOVERY_EMAIL_FROM for live email" },
    { channel: "sms", provider: sms ? "twilio" : "simulated", live: sms, reason: sms ? "Twilio SMS credentials configured" : "Set Twilio credentials and TWILIO_SMS_FROM for live SMS" },
    { channel: "whatsapp", provider: whatsapp ? "twilio" : "simulated", live: whatsapp, reason: whatsapp ? "Twilio WhatsApp credentials configured" : "Set Twilio credentials and TWILIO_WHATSAPP_FROM for live WhatsApp" },
    { channel: "voice", provider: voice ? "twilio" : "simulated", live: voice, reason: voice ? "Twilio Voice credentials configured" : "Set Twilio credentials and TWILIO_VOICE_FROM for live voice" },
  ];
}

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

export function buildRecoveryMessage(input: { amountAtRisk: number; rootCause?: string | null; paymentLinkUrl?: string | null }): string {
  const amount = formatRupees(input.amountAtRisk);
  const reason = input.rootCause ? ` We identified the issue as ${input.rootCause.split("_").join(" ")}.` : "";
  const link = input.paymentLinkUrl ? ` Complete payment securely: ${input.paymentLinkUrl}` : "";
  return `Recovery OS: Your ${amount} payment could not be completed.${reason}${link}`.trim();
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function sendWithResend(to: string, message: string): Promise<{ id: string | null; response: any }> {
  const apiKey = env("RESEND_API_KEY");
  const from = env("RECOVERY_EMAIL_FROM");
  if (!apiKey || !from) throw new Error("Resend is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject: "Payment recovery", text: message }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Resend request failed (${response.status}): ${JSON.stringify(body)}`);
  return { id: body?.id == null ? null : String(body.id), response: body };
}

async function sendWithTwilio(channel: "sms" | "whatsapp", to: string, message: string): Promise<{ id: string | null; response: any }> {
  const accountSid = env("TWILIO_ACCOUNT_SID");
  const authToken = env("TWILIO_AUTH_TOKEN");
  const from = channel === "sms" ? env("TWILIO_SMS_FROM") : env("TWILIO_WHATSAPP_FROM");
  if (!accountSid || !authToken || !from) throw new Error(`Twilio ${channel} is not configured`);
  const form = new URLSearchParams();
  form.set("From", channel === "whatsapp" && !from.startsWith("whatsapp:") ? `whatsapp:${from}` : from);
  form.set("To", channel === "whatsapp" && !to.startsWith("whatsapp:") ? `whatsapp:${to}` : to);
  form.set("Body", message);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: basicAuth(accountSid, authToken), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Twilio ${channel} request failed (${response.status}): ${JSON.stringify(body)}`);
  return { id: body?.sid == null ? null : String(body.sid), response: body };
}

async function sendVoiceWithTwilio(to: string, message: string): Promise<{ id: string | null; response: any }> {
  const accountSid = env("TWILIO_ACCOUNT_SID");
  const authToken = env("TWILIO_AUTH_TOKEN");
  const from = env("TWILIO_VOICE_FROM");
  if (!accountSid || !authToken || !from) throw new Error("Twilio voice is not configured");
  const safeMessage = message.split("&").join("and").split("<").join("").split(">").join("");
  const form = new URLSearchParams();
  form.set("From", from);
  form.set("To", to);
  form.set("Twiml", `<Response><Say>${safeMessage}</Say></Response>`);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
    method: "POST",
    headers: { Authorization: basicAuth(accountSid, authToken), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Twilio voice request failed (${response.status}): ${JSON.stringify(body)}`);
  return { id: body?.sid == null ? null : String(body.sid), response: body };
}

async function reserveCustomerContactSlot(client: PoolClient, input: {
  caseId: number;
  customerEmail: string;
  channel: RecoveryChannel;
}): Promise<number> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.customerEmail]);
  const contacts = await client.query(
    `SELECT COUNT(*) AS count
     FROM outbound_contacts
     WHERE customer_email = $1
       AND sent_at >= now() - interval '24 hours'`,
    [input.customerEmail]
  );
  if (Number(contacts.rows[0]?.count ?? 0) >= POLICY_LIMITS.maxContactsPerDay) {
    throw new Error(`Deterministic contact cap reached (${POLICY_LIMITS.maxContactsPerDay}/24h)`);
  }
  const reservation = await client.query(
    `INSERT INTO outbound_contacts (case_id, customer_email, channel, purpose, delivery_state)
     VALUES ($1, $2, $3, 'recovery', 'pending')
     RETURNING id`,
    [input.caseId, input.customerEmail, input.channel]
  );
  return Number(reservation.rows[0].id);
}

export async function sendRecoveryChannel(pool: Pool, input: ChannelSendInput) {
  const now = input.now ?? new Date();
  if (isQuietHours(now)) {
    const nextAllowed = nextAllowedContactTime(now);
    throw new Error(`Quiet-hours policy blocks manual channel delivery until ${nextAllowed.toISOString()}`);
  }

  const caseResult = await pool.query(
    `SELECT rc.id, rc.original_event_id, rc.customer_email, rc.amount_at_risk, rc.recovered_amount,
            rc.status,
            e.payload->'payload'->'payment'->'entity'->>'contact' AS phone,
            d.root_cause,
            a.response->>'short_url' AS payment_link_url
     FROM recovery_cases rc
     JOIN events e ON e.event_id = rc.original_event_id
     LEFT JOIN LATERAL (
       SELECT root_cause FROM diagnoses WHERE event_id = rc.original_event_id ORDER BY id DESC LIMIT 1
     ) d ON true
     LEFT JOIN LATERAL (
       SELECT response FROM actions
       WHERE starts_with(idempotency_key, rc.original_event_id || '_')
         AND razorpay_api_call = 'payment_links.create'
         AND status = 'success'
       ORDER BY id DESC LIMIT 1
     ) a ON true
     WHERE rc.id = $1`,
    [input.caseId]
  );
  if (caseResult.rows.length === 0) throw new Error(`Recovery case ${input.caseId} does not exist`);
  const row = caseResult.rows[0];
  if (["RECOVERED", "STOPPED", "ESCALATED"].includes(String(row.status))) throw new Error(`Recovery case is terminal (${row.status}); outbound contact is not allowed`);

  const email = row.customer_email == null ? null : String(row.customer_email);
  const phone = row.phone == null ? null : String(row.phone);
  const recipient = input.channel === "email" ? email : phone;
  if (!recipient) throw new Error(`No ${input.channel === "email" ? "email" : "phone number"} is available for this recovery case`);

  const message = input.message?.trim() || buildRecoveryMessage({
    amountAtRisk: Math.max(0, Number(row.amount_at_risk ?? 0) - Number(row.recovered_amount ?? 0)),
    rootCause: row.root_cause == null ? null : String(row.root_cause),
    paymentLinkUrl: row.payment_link_url == null ? null : String(row.payment_link_url),
  });

  const status = getChannelProviderStatus().find((item) => item.channel === input.channel)!;
  const idempotencyKey = `${row.original_event_id}_${input.channel}_${randomUUID()}`;
  const client = await pool.connect();
  let contactId: number | null = null;
  let deliveryId: number | null = null;
  try {
    await client.query("BEGIN");
    contactId = await reserveCustomerContactSlot(client, {
      caseId: input.caseId,
      customerEmail: email ?? recipient,
      channel: input.channel,
    });
    const claimed = await client.query(
      `INSERT INTO channel_deliveries (case_id, event_id, channel, recipient, message, provider, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7) RETURNING id`,
      [input.caseId, row.original_event_id, input.channel, recipient, message, status.provider, idempotencyKey]
    );
    deliveryId = Number(claimed.rows[0].id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  try {
    let providerMessageId: string | null = null;
    let providerResponse: any = { mode: "simulated", reason: status.reason };
    let finalStatus = "SIMULATED";
    if (status.live) {
      if (input.channel === "email") ({ id: providerMessageId, response: providerResponse } = await sendWithResend(recipient, message));
      else if (input.channel === "sms" || input.channel === "whatsapp") ({ id: providerMessageId, response: providerResponse } = await sendWithTwilio(input.channel, recipient, message));
      else ({ id: providerMessageId, response: providerResponse } = await sendVoiceWithTwilio(recipient, message));
      finalStatus = "ACCEPTED";
    }
    await pool.query(`UPDATE channel_deliveries SET status = $2, provider_message_id = $3, response = $4, updated_at = now() WHERE id = $1`, [deliveryId, finalStatus, providerMessageId, providerResponse]);
    await pool.query(`UPDATE outbound_contacts SET delivery_state = $2 WHERE id = $1`, [contactId, finalStatus.toLowerCase()]);
    return { id: deliveryId, channel: input.channel, recipient, provider: status.provider, live: status.live, status: finalStatus, providerMessageId, message };
  } catch (error: any) {
    await pool.query(`UPDATE channel_deliveries SET status = 'FAILED', response = $2, updated_at = now() WHERE id = $1`, [deliveryId, { error: error.message }]);
    if (contactId != null) await pool.query("DELETE FROM outbound_contacts WHERE id = $1 AND delivery_state = 'pending'", [contactId]);
    throw error;
  }
}

export async function listChannelDeliveries(pool: Pool, limit = 100) {
  const bounded = Math.min(200, Math.max(1, limit));
  const result = await pool.query(`SELECT id, case_id, event_id, channel, recipient, provider, provider_message_id, status, message, created_at, updated_at FROM channel_deliveries ORDER BY created_at DESC LIMIT $1`, [bounded]);
  return result.rows.map((row) => ({ id: Number(row.id), caseId: Number(row.case_id), eventId: String(row.event_id), channel: String(row.channel), recipient: String(row.recipient), provider: String(row.provider), providerMessageId: row.provider_message_id == null ? null : String(row.provider_message_id), status: String(row.status), message: String(row.message), createdAt: row.created_at, updatedAt: row.updated_at }));
}
