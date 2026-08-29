import "dotenv/config";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
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

const DIAGNOSIS_FUNCTION = {
  name: "submit_diagnosis",
  description: "Submit a structured diagnosis for why a payment failed.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      root_cause: {
        type: SchemaType.STRING,
        format: "enum",
        enum: [...ALLOWED_CAUSES],
        description: "The single most likely root cause of the payment failure.",
      },
      rationale: {
        type: SchemaType.STRING,
        description: "A brief written explanation of why this root cause was chosen, referencing the specific evidence.",
      },
      confidence: {
        type: SchemaType.NUMBER,
        description: "Confidence in this diagnosis, from 0.0 to 1.0.",
      },
    },
    required: ["root_cause", "rationale", "confidence"],
  },
};

export async function diagnose(evidence: EvidenceBundle): Promise<Diagnosis> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing from .env");
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-3.6-flash",
    tools: [{ functionDeclarations: [DIAGNOSIS_FUNCTION] }],
    toolConfig: {
      functionCallingConfig: {
        mode: "ANY" as any,
        allowedFunctionNames: ["submit_diagnosis"],
      },
    },
  });

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

  const result = await model.generateContent(prompt);
  const call = result.response.functionCalls()?.[0];

  if (!call || call.name !== "submit_diagnosis") {
    throw new Error("Model did not return a submit_diagnosis function call");
  }

  return call.args as Diagnosis;
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

// Only auto-run when this file is executed directly (e.g. `npx tsx src/diagnosis/diagnose.ts`).
// Without this guard, importing diagnose() from another file (like diagnoseBatch.ts)
// would also silently trigger this main() block and fire an extra, unwanted API call.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error("Diagnosis failed:", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}