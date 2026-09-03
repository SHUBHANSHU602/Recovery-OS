import { verify } from "./verify";
import type { EvidenceBundle } from "../evidence/gatherEvidence";

// A real isolated-failure evidence bundle (customer3, HDFC, from batch_1 -- 0 correlated failures)
const isolatedEvidence: EvidenceBundle = {
  eventId: "test_isolated",
  errorCode: "GATEWAY_ERROR",
  errorDescription: "Card has expired",
  customerEmail: "customer3@example.com",
  bank: "HDFC",
  amount: 33447,
  customerFailureCount: 0,
  correlatedFailuresAtSameBank: 0,
  evidenceCutoffAt: "2026-09-01T10:00:00.000Z",
};

const badDiagnosis = {
  root_cause: "systemic_bank_outage",
  rationale: "This looks like a bank-wide issue.",
  confidence: 0.85,
};

const goodDiagnosis = {
  root_cause: "expired_card",
  rationale: "Card has expired, and there's no correlated failure pattern.",
  confidence: 0.95,
};

console.log("=== Test 1: Deliberately wrong diagnosis (claims systemic outage with 0 correlation) ===");
console.log(verify(badDiagnosis, isolatedEvidence));

console.log("\n=== Test 2: Correct diagnosis over the same evidence ===");
console.log(verify(goodDiagnosis, isolatedEvidence));

const outageEvidence: EvidenceBundle = {
  eventId: "test_outage",
  errorCode: "GATEWAY_ERROR",
  errorDescription: "Payment authorization timed out",
  customerEmail: "customer5@example.com",
  bank: "AXIS",
  amount: 91355,
  customerFailureCount: 0,
  correlatedFailuresAtSameBank: 3,
  evidenceCutoffAt: "2026-09-01T10:30:00.000Z",
};

const correctOutageDiagnosis = {
  root_cause: "systemic_bank_outage",
  rationale: "3 correlated failures at AXIS in the last 30 minutes.",
  confidence: 0.9,
};

console.log("\n=== Test 3: Correct systemic_bank_outage claim WITH real supporting evidence ===");
console.log(verify(correctOutageDiagnosis, outageEvidence));

const malformedDiagnosis = {
  root_cause: "expired_card",
  rationale: "Card expired.",
  confidence: 1.5,
};

console.log("\n=== Test 4: Malformed confidence value (1.5, outside 0-1 range) ===");
console.log(verify(malformedDiagnosis, isolatedEvidence));
