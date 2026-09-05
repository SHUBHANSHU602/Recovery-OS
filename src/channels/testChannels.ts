import assert from "node:assert/strict";
import { buildRecoveryMessage, getChannelProviderStatus } from "./channelService";

const message = buildRecoveryMessage({
  amountAtRisk: 70351,
  rootCause: "systemic_bank_outage",
  paymentLinkUrl: "https://example.test/pay",
});

assert.match(message, /₹703\.51/);
assert.match(message, /systemic bank outage/);
assert.match(message, /https:\/\/example\.test\/pay/);

const providers = getChannelProviderStatus();
assert.deepEqual(providers.map((item) => item.channel), ["email", "sms", "whatsapp", "voice"]);
for (const provider of providers) {
  assert.ok(["resend", "twilio", "simulated"].includes(provider.provider));
  assert.equal(typeof provider.live, "boolean");
  assert.ok(provider.reason.length > 0);
}

console.log("Channel adapter tests passed.");
