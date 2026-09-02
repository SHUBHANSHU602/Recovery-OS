import "dotenv/config";
import Groq from "groq-sdk";
import { Pool } from "pg";
import { checkCustomerRiskFlags, generatePaymentLink, escalateToHuman } from "./tools";

const pool = new Pool();

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "check_customer_risk_flags",
      description: "Check this customer's payment failure history to see if they're flagged as high-risk.",
      parameters: { type: "object", properties: { customerEmail: { type: "string" } }, required: ["customerEmail"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "generate_payment_link",
      description: "Request a policy-gated payment link for the current recovery case.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "escalate_to_human",
      description: "Escalate this conversation to a human agent.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
];

function buildSystemPrompt(customerEmail: string, amount: number): string {
  return `You are a payment recovery assistant helping a customer whose payment failed.

Known trusted context:
- Customer email: ${customerEmail}
- Amount due: ${amount} paise (₹${(amount / 100).toFixed(2)})

Be brief and helpful. Tools request intents only; deterministic backend policy decides whether a side effect is allowed. Never ask the customer to provide an amount or identity that the backend already knows. Escalate instead of guessing.`;
}

async function getOrCreateConversation(eventId: string, customerEmail: string, amount: number) {
  const convoResult = await pool.query("SELECT id, messages FROM conversations WHERE event_id = $1", [eventId]);
  if (convoResult.rows.length > 0) {
    return { id: Number(convoResult.rows[0].id), messages: convoResult.rows[0].messages as any[] };
  }
  const messages: any[] = [{ role: "system", content: buildSystemPrompt(customerEmail, amount) }];
  const inserted = await pool.query(
    "INSERT INTO conversations (event_id, messages) VALUES ($1, $2) RETURNING id",
    [eventId, JSON.stringify(messages)]
  );
  return { id: Number(inserted.rows[0].id), messages };
}

// Recovery OS initiating contact is an assistant/outbound message. It must never be fed back as a user turn.
export async function startOutboundRecoveryMessage(
  eventId: string,
  customerEmail: string,
  amount: number,
  openingMessage: string
): Promise<void> {
  const conversation = await getOrCreateConversation(eventId, customerEmail, amount);
  conversation.messages.push({ role: "assistant", content: openingMessage });
  await pool.query(
    "UPDATE conversations SET messages = $1, updated_at = now() WHERE id = $2",
    [JSON.stringify(conversation.messages), conversation.id]
  );
}

// This function is exclusively for genuine inbound customer text.
export async function runAgentTurn(eventId: string, customerEmail: string, amount: number, userMessage: string) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const conversation = await getOrCreateConversation(eventId, customerEmail, amount);
  const messages = conversation.messages;

  messages.push({ role: "user", content: userMessage });

  let response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages,
    tools: TOOLS,
  });
  let assistantMessage = response.choices[0].message;
  messages.push(assistantMessage);

  while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments || "{}");
      let result: any;
      if (toolCall.function.name === "check_customer_risk_flags") {
        result = await checkCustomerRiskFlags(customerEmail);
      } else if (toolCall.function.name === "generate_payment_link") {
        result = await generatePaymentLink(eventId, amount);
      } else if (toolCall.function.name === "escalate_to_human") {
        result = await escalateToHuman(eventId, args.reason);
      } else {
        result = { status: "blocked", reason: "Unknown tool" };
      }
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
    }

    response = await groq.chat.completions.create({ model: "openai/gpt-oss-120b", messages, tools: TOOLS });
    assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);
  }

  await pool.query(
    "UPDATE conversations SET messages = $1, updated_at = now() WHERE id = $2",
    [JSON.stringify(messages), conversation.id]
  );
  return assistantMessage.content;
}
