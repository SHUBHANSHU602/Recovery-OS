import { applyPolicyGate } from "./policyGate";

console.log("=== Test 1: planner wants issue_recovery_payment_link, but recovery-link attempt cap is exceeded ===");
console.log(applyPolicyGate({
  chosenAction: "issue_recovery_payment_link",
  customerFailureCount: 4,
  customerContactedInLast24h: false,
}));

console.log("\n=== Test 2: planner wants issue_recovery_payment_link with capacity remaining -- should be approved ===");
console.log(applyPolicyGate({
  chosenAction: "issue_recovery_payment_link",
  customerFailureCount: 1,
  customerContactedInLast24h: false,
}));

console.log("\n=== Test 3: planner wants whatsapp_nudge, but customer was already contacted today ===");
console.log(applyPolicyGate({
  chosenAction: "whatsapp_nudge",
  customerFailureCount: 0,
  customerContactedInLast24h: true,
}));

console.log("\n=== Test 4: escalate_to_human is always fine, no caps apply to it ===");
console.log(applyPolicyGate({
  chosenAction: "escalate_to_human",
  customerFailureCount: 10,
  customerContactedInLast24h: true,
}));
