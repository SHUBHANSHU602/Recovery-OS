import "dotenv/config";
import Groq from "groq-sdk";

const ALLOWED_ACTIONS = [
  "retry_now",
  "retry_with_backoff",
  "offer_alternate_payment_method",
  "whatsapp_nudge",
  "escalate_to_human",
] as const;

export type Action = (typeof ALLOWED_ACTIONS)[number];

interface Intervention {
  chosen_action: Action;
  reasoning: string;
}

export interface ActionContext {
  rootCause: string;
  confidence: number;
  customerFailureCount: number;
  amountAtRisk: number;
  correlatedFailuresAtSameBank: number;
  automatedRetryCount: number;
  contactsLast24h: number;
  priorRecoveryOutcomes: Array<{
    strategy: string | null;
    status: string;
    recoveredAmount: number;
  }>;
}

const ACTION_TOOL = {
  type: "function" as const,
  function: {
    name: "choose_action",
    description: "Choose the single best recovery action from the fixed approved menu.",
    parameters: {
      type: "object",
      properties: {
        chosen_action: {
          type: "string",
          enum: [...ALLOWED_ACTIONS],
          description: "The recovery action to take, chosen strictly from the approved menu.",
        },
        reasoning: {
          type: "string",
          description: "Why this action fits the diagnosis, customer context, prior outcomes, and current recovery constraints.",
        },
      },
      required: ["chosen_action", "reasoning"],
      additionalProperties: false,
    },
  },
};

function parseIntervention(argumentsJson: string): Intervention {
  let parsed: any;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new Error("Model returned malformed JSON for intervention selection");
  }

  if (!ALLOWED_ACTIONS.includes(parsed?.chosen_action as Action)) {
    throw new Error(`Model returned unsupported recovery action: ${String(parsed?.chosen_action)}`);
  }
  if (typeof parsed?.reasoning !== "string" || parsed.reasoning.trim().length === 0) {
    throw new Error("Model returned an empty intervention rationale");
  }

  return {
    chosen_action: parsed.chosen_action,
    reasoning: parsed.reasoning.trim(),
  };
}

export async function chooseAction(context: ActionContext): Promise<Intervention> {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing from .env");

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const priorOutcomes = context.priorRecoveryOutcomes.length
    ? context.priorRecoveryOutcomes
        .map((item) => `${item.strategy ?? "unknown"}: ${item.status}, recovered ${item.recoveredAmount} paise`)
        .join("; ")
    : "none";

  const prompt = `A payment failed and was diagnosed. Choose one recovery action from the fixed approved menu.

Current case:
- Root cause: ${context.rootCause}
- Diagnosis confidence: ${context.confidence}
- Amount at risk: ${context.amountAtRisk} paise
- Customer's prior failed-payment count: ${context.customerFailureCount}
- Other failures at the same bank in the evidence window: ${context.correlatedFailuresAtSameBank}
- Automated recovery attempts already made for this case: ${context.automatedRetryCount}
- Recovery contacts sent to this customer in the last 24h: ${context.contactsLast24h}
- Prior recovery outcomes for this customer: ${priorOutcomes}

Reason over the whole context rather than applying a one-to-one root-cause lookup. Examples of trade-offs:
- A systemic outage usually favors delayed retry, but repeated failed recovery attempts should push toward escalation.
- An expired card usually needs an alternate method or customer interaction, but recent contact limits and prior failed outreach matter.
- Insufficient funds may justify waiting or a nudge; repeated historical failures and high-value cases can justify human review sooner.
- Ambiguous diagnoses should generally be escalated rather than acted on confidently.
- Do not try to bypass policy limits. The deterministic policy gate will independently enforce them after your recommendation.

Call choose_action with the single best recommendation and concise reasoning.`;

  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [{ role: "user", content: prompt }],
    tools: [ACTION_TOOL],
    tool_choice: { type: "function", function: { name: "choose_action" } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Model did not return an intervention tool call");
  return parseIntervention(toolCall.function.arguments);
}
