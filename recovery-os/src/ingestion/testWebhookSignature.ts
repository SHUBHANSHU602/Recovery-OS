import assert from "assert";
import { createHmac } from "crypto";
import { verifyRazorpayWebhookSignature } from "./verifyWebhookSignature";

const secret = "test_webhook_secret";
const raw = Buffer.from(JSON.stringify({ event: "payment.failed", payload: { test: true } }));
const validSignature = createHmac("sha256", secret).update(raw).digest("hex");

assert.equal(verifyRazorpayWebhookSignature(raw, validSignature, secret), true);
assert.equal(verifyRazorpayWebhookSignature(raw, "0".repeat(64), secret), false);
assert.equal(verifyRazorpayWebhookSignature(Buffer.from(raw.toString() + " "), validSignature, secret), false);

console.log("Webhook signature tests passed: valid accepted, tampered/invalid rejected.");
