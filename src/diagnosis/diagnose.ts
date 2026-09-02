import "dotenv/config";
import Groq from "groq-sdk";
import { Pool } from "pg";
import { gatherEvidence } from "../evidence/gatherEvidence";
import type { EvidenceBundle } from "../evidence/gatherEvidence";

const pool = new Pool();

const ALLOWED_CAUSES = [
  "insufficient_funds",
  "expired_card",
  "systemic_bank_outage",
  "ambiguous",
] as const;

type RootCause = (typeof ALLOWED_CAUSES)[number];

interface Diagnosis {
  root_cause: RootCause;
  rationale: string;
  confidence: number;
}

const DIAGNOSIS_TOOL = {
  type: "function" as const,
  function: {
    name: "submit_diagnosis",
    description: "Submit a structured diagnosis for why a payment failed.",
    parameters: {
      type: "object",
      properties: {
        root_cause: {
          type: "string",
          enum: [...ALLOWED_CAUSES],
          description: "The single most likely root cause of the payment failure.",
        },
        rationale: {
          type: "string",
          description: "A brief written explanation of why this root cause was chosen, referencing the specific evidence.",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Confidence in this diagnosis, from 0.0 to 1.0.",
        },
      },
      required: ["root_cause", "rationale", "confidence"],
      additionalProperties: false,
    },
  },
};

function parseDiagnosis(argumentsJson: string): Diagnosis {
  let parsed: any;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new Error("Model returned malformed JSON for diagnosis");
  }

  if (!ALLOWED_CAUSES.includes(parsed?.root_cause as RootCause)) {
    throw new Error(`Model returned unsupported root cause: ${String(parsed?.root_cause)}`);
  }
  if (typeof parsed?.rationale !== "string" || parsed.rationale.trim().length === 0) {
    throw new Error("Model returned an empty diagnosis rationale");
  }
  if (typeof parsed?.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new Error(`Model returned invalid diagnosis confidence: ${String(parsed?.confidence)}`);
  }

  return {
    root_cause: parsed.root_cause,
    rationale: parsed.rationale.trim(),
    confidence: parsed.confidence,
  };
}

export async function diagnose(evidence: EvidenceBundle): Promise<Diagnosis> {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing from .env");

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const prompt = `You are diagnosing why a payment failed, given evidence gathered from our system.

Error code: ${evidence.errorCode}
Error description: ${evidence.errorDescription}
Bank: ${evidence.bank}
Amount: ${evidence.amount} paise
This customer's earlier failed payments: ${evidence.customerFailureCount}
Other customers who failed at the SAME bank in the preceding 30 minutes: ${evidence.correlatedFailuresAtSameBank}

Reason only from evidence that is actually present.
- Two or more earlier correlated failures at the same bank can support systemic_bank_outage, especially when the outward gateway error is generic.
- Zero or one correlated failure argues against claiming an established systemic outage, but it does NOT by itself prove insufficient funds or an expired card.
- Use customer-specific causes only when the payment error text/code or historical context genuinely supports that cause.
- For generic declines/timeouts with insufficient causal evidence, choose ambiguous rather than inventing a customer-specific explanation.
- Do not use information that would only become known after this event.

Call submit_diagnosis with your conclusion.`;

  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [{ role: "user", content: prompt }],
    tools: [DIAGNOSIS_TOOL],
    tool_choice: { type: "function", function: { name: "submit_diagnosis" } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Model did not return a diagnosis tool call");
  return parseDiagnosis(toolCall.function.arguments);
}

async function findDefaultEventId(): Promise<string> {
  const result = await pool.query(
    "SELECT event_id FROM recovery_batches WHERE batch_name = 'batch_1' ORDER BY id LIMIT 1"
  );
  if (result.rows.length === 0) throw new Error("No events found in recovery batch batch_1");
  return result.rows[0].event_id;
}

async function main() {
  const eventId = process.argv[2] || (await findDefaultEventId());
  const evidence = await gatherEvidence(eventId);
  const diagnosis = await diagnose(evidence);
  console.log(`Diagnosis for ${eventId}:`);
  console.log(JSON.stringify(diagnosis, null, 2));
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("Diagnosis failed:", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
