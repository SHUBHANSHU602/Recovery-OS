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

interface Diagnosis {
  root_cause: (typeof ALLOWED_CAUSES)[number];
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
          description: "Confidence in this diagnosis, from 0.0 to 1.0.",
        },
      },
      required: ["root_cause", "rationale", "confidence"],
    },
  },
};

export async function diagnose(evidence: EvidenceBundle): Promise<Diagnosis> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing from .env");
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const prompt = `You are diagnosing why a payment failed, given evidence gathered from our system.

Error code: ${evidence.errorCode}
Error description: ${evidence.errorDescription}
Bank: ${evidence.bank}
Amount: ${evidence.amount} paise
This customer's other recent failures: ${evidence.customerFailureCount}
Other customers who failed at the SAME bank in the last 30 minutes: ${evidence.correlatedFailuresAtSameBank}

Reason carefully about what these signals together suggest. In particular:
- A high correlated-failure count at the same bank suggests a systemic bank-side outage, not an individual customer issue -- even if the error code alone looks like a generic decline.
- A low or zero correlated-failure count means this is very likely an isolated, customer-specific issue.
- If the evidence is genuinely insufficient to distinguish between causes, choose "ambiguous" rather than guessing confidently.

Call submit_diagnosis with your conclusion.`;

  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [{ role: "user", content: prompt }],
    tools: [DIAGNOSIS_TOOL],
    tool_choice: { type: "function", function: { name: "submit_diagnosis" } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    throw new Error("Model did not return a tool call");
  }

  return JSON.parse(toolCall.function.arguments) as Diagnosis;
}

async function findDefaultEventId(): Promise<string> {
  const result = await pool.query(
    "SELECT event_id FROM recovery_batches WHERE batch_name = 'batch_1' ORDER BY id LIMIT 1"
  );
  if (result.rows.length === 0) {
    throw new Error("No events found in recovery batch batch_1");
  }
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