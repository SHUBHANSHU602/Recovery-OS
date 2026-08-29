import { applyPolicyGate } from "./policyGate";

console.log("=== Test 1: LLM wants retry_now, but customer already failed 4 times (over the cap of 3) ===");
console.log(applyPolicyGate({
  chosenAction: "retry_now",
  customerFailureCount: 4,
  customerContactedInLast24h: false,
}));

console.log("\n=== Test 2: LLM wants retry_now, customer has failed only once -- should be approved ===");
console.log(applyPolicyGate({
  chosenAction: "retry_now",
  customerFailureCount: 1,
  customerContactedInLast24h: false,
}));

console.log("\n=== Test 3: LLM wants whatsapp_nudge, but customer was already contacted today ===");
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