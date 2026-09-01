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
      parameters: {
        type: "object",
        properties: { customerEmail: { type: "string" } },
        required: ["customerEmail"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "generate_payment_link",
      description: "Generate a new Razorpay payment link for the customer to retry payment, e.g. with an alternate method.",
      parameters: {
        type: "object",
        properties: { amount: { type: "number", description: "Amount in paise" } },
        required: ["amount"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "escalate_to_human",
      description: "Escalate this conversation to a human agent -- use when the customer is upset, confused, or the situation is beyond what you can resolve.",
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

Known context (you already have this, never ask the customer for it):
- Customer email: ${customerEmail}
- Amount due: ${amount} paise (₹${(amount / 100).toFixed(2)})

Be brief, warm, and helpful. Your job is to understand why they couldn't pay and help them complete it --
using tools when appropriate, not just chatting. If they mention a card issue, offer to generate a new
payment link so they can use a different method -- you have everything you need to do this immediately,
don't ask the customer for their email or the amount. If they seem frustrated or the issue is unclear,
escalate to a human rather than guessing. Never make promises about refunds or account changes you can't verify.`;
}

export async function runAgentTurn(eventId: string, customerEmail: string, amount: number, userMessage: string) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const convoResult = await pool.query("SELECT id, messages FROM conversations WHERE event_id = $1", [eventId]);
  let conversationId: number;
  let messages: any[];

  if (convoResult.rows.length === 0) {
    messages = [{ role: "system", content:buildSystemPrompt(customerEmail, amount)}];
    const inserted = await pool.query(
      "INSERT INTO conversations (event_id, messages) VALUES ($1, $2) RETURNING id",
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

  // Tool-calling loop: keep resolving tool calls until the agent responds with plain text
  while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      let result: any;

      if (toolCall.function.name === "check_customer_risk_flags") {
        result = await checkCustomerRiskFlags(customerEmail);
      } else if (toolCall.function.name === "generate_payment_link") {
        result = await generatePaymentLink(eventId, amount);
      } else if (toolCall.function.name === "escalate_to_human") {
        result = await escalateToHuman(eventId, args.reason);
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    response = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages,
      tools: TOOLS,
    });
    assistantMessage = response.choices[0].message;
    messages.push(assistantMessage);
  }

  await pool.query("UPDATE conversations SET messages = $1, updated_at = now() WHERE id = $2", [JSON.stringify(messages), conversationId]);

  return assistantMessage.content;
}