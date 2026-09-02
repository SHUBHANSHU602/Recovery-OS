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
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "generate_payment_link",
      description: "Request a policy-checked Razorpay recovery payment link for the current customer and failed payment.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "escalate_to_human",
      description: "Escalate this conversation to a human agent when the situation is unclear or requires manual handling.",
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

Known backend context (never ask the customer to repeat it):
- Customer email: ${customerEmail}
- Amount due: ${amount} paise (₹${(amount / 100).toFixed(2)})

Be brief and helpful. Use tools when an action is needed. Tools are policy-checked by the backend, so if a tool reports that an action is blocked, explain that a human will take over rather than trying to bypass the block. Never make promises about refunds or account changes you cannot verify.`;
}

export async function startConversation(
  eventId: string,
  customerEmail: string,
  amount: number,
  openingMessage: string
): Promise<void> {
  const existing = await pool.query("SELECT id FROM conversations WHERE event_id = $1", [eventId]);
  if (existing.rows.length > 0) return;

  const messages = [
    { role: "system", content: buildSystemPrompt(customerEmail, amount) },
    { role: "assistant", content: openingMessage },
  ];

  await pool.query(
    "INSERT INTO conversations (event_id, messages, status) VALUES ($1, $2, 'active')",
    [eventId, JSON.stringify(messages)]
  );
}

export async function runAgentTurn(eventId: string, customerEmail: string, amount: number, userMessage: string) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const convoResult = await pool.query("SELECT id, messages FROM conversations WHERE event_id = $1", [eventId]);
  let conversationId: number;
  let messages: any[];

  if (convoResult.rows.length === 0) {
    messages = [{ role: "system", content: buildSystemPrompt(customerEmail, amount) }];
    const inserted = await pool.query(
      "INSERT INTO conversations (event_id, messages, status) VALUES ($1, $2, 'active') RETURNING id",
      [eventId, JSON.stringify(messages)]
    );
    conversationId = inserted.rows[0].id;
  } else {
    conversationId = convoResult.rows[0].id;
    messages = convoResult.rows[0].messages;
  }

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
        result = await generatePaymentLink(eventId, amount, customerEmail);
      } else if (toolCall.function.name === "escalate_to_human") {
        result = await escalateToHuman(eventId, args.reason);
      } else {
        result = { error: "Unknown tool requested." };
      }

      messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
    }

    response = await groq.chat.completions.create({ model: "openai/gpt-oss-120b", messages, tools: TOOLS });
    assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);
  }

  await pool.query("UPDATE conversations SET messages = $1, updated_at = now() WHERE id = $2", [JSON.stringify(messages), conversationId]);
  return assistantMessage.content;
}
