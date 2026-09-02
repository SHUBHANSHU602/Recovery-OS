import assert from "assert";
import { applyPolicyGate } from "./policyGate";

const tooManyAttempts = applyPolicyGate({
  chosenAction: "retry_now",
  automatedRecoveryAttemptCount: 3,
  customerContactedInLast24h: false,
  paymentAlreadyRecovered: false,
});
assert.equal(tooManyAttempts.result, "BLOCKED_ESCALATED");
assert.equal(tooManyAttempts.finalAction, "escalate_to_human");

const allowedRetry = applyPolicyGate({
  chosenAction: "retry_now",
  automatedRecoveryAttemptCount: 1,
  customerContactedInLast24h: false,
  paymentAlreadyRecovered: false,
});
assert.equal(allowedRetry.result, "APPROVED");

const repeatedContact = applyPolicyGate({
  chosenAction: "whatsapp_nudge",
  automatedRecoveryAttemptCount: 0,
  customerContactedInLast24h: true,
  paymentAlreadyRecovered: false,
});
assert.equal(repeatedContact.result, "BLOCKED_ESCALATED");

const alreadyRecovered = applyPolicyGate({
  chosenAction: "retry_with_backoff",
  automatedRecoveryAttemptCount: 0,
  customerContactedInLast24h: false,
  paymentAlreadyRecovered: true,
});
assert.equal(alreadyRecovered.result, "BLOCKED_STOPPED");
assert.equal(alreadyRecovered.finalAction, "stop_recovery");

console.log("Policy gate tests passed: 4/4");
