import { createHmac, timingSafeEqual } from "crypto";

export function verifyRazorpayWebhookSignature(
  rawBody: Buffer,
  receivedSignature: string,
  secret: string
): boolean {
  const expectedSignature = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedSignature, "utf8");
  const received = Buffer.from(receivedSignature, "utf8");

  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
