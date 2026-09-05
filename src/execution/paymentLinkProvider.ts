import { Pool } from "pg";
import { ensureRecoveryPaymentLinkSchema, updateRecoveryPaymentLinkProviderState } from "../recovery/recoveryPaymentLinks";

function authHeader(): string {
  return `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`;
}

async function providerState(paymentLinkId: string): Promise<{ status: string; amountPaid: number }> {
  const response = await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(paymentLinkId)}`, {
    headers: { Authorization: authHeader() },
  });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    throw new Error(body?.error?.description ?? body?.error?.reason ?? `Razorpay returned HTTP ${response.status}`);
  }
  return { status: String(body.status ?? "unknown"), amountPaid: Number(body.amount_paid ?? 0) };
}

export async function cancelOutstandingRecoveryPaymentLinks(
  pool: Pool,
  caseId: number,
  exceptPaymentLinkId: string | null = null
): Promise<Array<{ paymentLinkId: string; outcome: string }>> {
  await ensureRecoveryPaymentLinkSchema(pool);
  const candidates = await pool.query(
    `SELECT payment_link_id
     FROM recovery_payment_links
     WHERE case_id = $1
       AND payment_link_id <> COALESCE($2, '')
       AND status IN ('ACTIVE', 'SUPERSEDED')
     ORDER BY created_at ASC, id ASC`,
    [caseId, exceptPaymentLinkId]
  );

  const outcomes: Array<{ paymentLinkId: string; outcome: string }> = [];
  for (const row of candidates.rows) {
    const paymentLinkId = String(row.payment_link_id);
    try {
      const current = await providerState(paymentLinkId);
      await updateRecoveryPaymentLinkProviderState(pool, paymentLinkId, current.status, current.amountPaid);

      if (current.status === "created") {
        const response = await fetch(
          `https://api.razorpay.com/v1/payment_links/${encodeURIComponent(paymentLinkId)}/cancel`,
          { method: "POST", headers: { Authorization: authHeader(), "Content-Type": "application/json" } }
        );
        const body = await response.json().catch(() => ({})) as any;
        if (!response.ok) {
          throw new Error(body?.error?.description ?? body?.error?.reason ?? `Razorpay cancel returned HTTP ${response.status}`);
        }
        const status = String(body.status ?? "cancelled");
        await updateRecoveryPaymentLinkProviderState(pool, paymentLinkId, status, Number(body.amount_paid ?? 0));
        outcomes.push({ paymentLinkId, outcome: status });
      } else {
        outcomes.push({ paymentLinkId, outcome: current.status });
      }
    } catch (error: any) {
      outcomes.push({ paymentLinkId, outcome: `ERROR: ${error.message}` });
    }
  }

  return outcomes;
}
