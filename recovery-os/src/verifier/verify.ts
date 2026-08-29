import "dotenv/config";
import { Pool } from "pg";
import type { EvidenceBundle } from "../evidence/gatherEvidence";

const pool = new Pool();

interface Diagnosis {
  root_cause: string;
  rationale: string;
  confidence: number;
}

type VerifierResult = "PASSED" | "FAILED_INVARIANT" | "MALFORMED";

interface VerificationOutcome {
  result: VerifierResult;
  reason: string;
  finalRootCause: string; // may differ from the original if downgraded
}

export function verify(diagnosis: Diagnosis, evidence: EvidenceBundle): VerificationOutcome {
  // Malformed confidence check first -- if the LLM broke its own schema, nothing else matters
  if (diagnosis.confidence < 0 || diagnosis.confidence > 1 || isNaN(diagnosis.confidence)) {
    return {
      result: "MALFORMED",
      reason: `Confidence ${diagnosis.confidence} is outside the valid 0-1 range.`,
      finalRootCause: "ambiguous",
    };
  }

  // Invariant: a systemic_bank_outage claim requires real correlated evidence
  if (diagnosis.root_cause === "systemic_bank_outage") {
    if (evidence.correlatedFailuresAtSameBank < 2) {
      return {
        result: "FAILED_INVARIANT",
        reason: `Diagnosis claimed systemic_bank_outage, but only ${evidence.correlatedFailuresAtSameBank} correlated failure(s) found at ${evidence.bank} -- not enough evidence for a systemic claim.`,
        finalRootCause: "ambiguous",
      };
    }
  }

  // Invariant: a single-customer explanation is suspect if correlation is actually high
  if (
    (diagnosis.root_cause === "insufficient_funds" || diagnosis.root_cause === "expired_card") &&
    evidence.correlatedFailuresAtSameBank >= 2
  ) {
    return {
      result: "FAILED_INVARIANT",
      reason: `Diagnosis claimed a customer-specific cause (${diagnosis.root_cause}), but ${evidence.correlatedFailuresAtSameBank} correlated failures exist at ${evidence.bank} -- this pattern looks systemic, not isolated. Escalating for review.`,
      finalRootCause: "ambiguous",
    };
  }

  return {
    result: "PASSED",
    reason: "Diagnosis is consistent with the gathered evidence.",
    finalRootCause: diagnosis.root_cause,
  };
}