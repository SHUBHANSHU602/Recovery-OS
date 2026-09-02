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

interface ActionContext {
  rootCause: string;
  confidence: number;
  customerFailureCount: number; // how many times this customer has failed before, total
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
          description: "Why this action fits the root cause and the customer's prior attempt history.",
        },
      },
      required: ["chosen_action", "reasoning"],
    },
  },
};

export async function chooseAction(context: ActionContext): Promise<Intervention> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing from .env");
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const prompt = `A payment failed and was diagnosed. Choose the best recovery action from the fixed menu.

Root cause: ${context.rootCause}
Diagnosis confidence: ${context.confidence}
This customer's total prior failed-payment attempts: ${context.customerFailureCount}

Guidance:
- systemic_bank_outage -> usually retry_with_backoff (the bank issue may resolve shortly; retrying immediately is pointless).
- expired_card -> usually offer_alternate_payment_method (retrying won't help, the card itself is the problem) or whatsapp_nudge to get updated card details.
- insufficient_funds -> usually whatsapp_nudge or retry_with_backoff (funds may become available later).
- ambiguous -> usually escalate_to_human, since we don't have a confident enough diagnosis to act automatically.
- If this customer has already failed many times before, prefer escalate_to_human over another automated attempt -- repeated automated retries on a customer who keeps failing is poor practice, not persistence.

Call choose_action with your decision.`;

  const response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [{ role: "user", content: prompt }],
    tools: [ACTION_TOOL],
    tool_choice: { type: "function", function: { name: "choose_action" } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    throw new Error("Model did not return a tool call");
  }

  return JSON.parse(toolCall.function.arguments) as Intervention;
}