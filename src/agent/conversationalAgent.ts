import "dotenv/config";
import Groq from "groq-sdk";
import { Pool } from "pg";
import { checkCustomerRiskFlags, generatePaymentLink, recordPromiseToPay, escalateToHuman } from "./tools";
import { loadPolicyContext } from "../policy/policyContext";
import { logAuditEvent } from "../ledger/auditLog";

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
      name: "record_promise_to_pay",
      description: "Persist a future payment commitment only when the customer explicitly promises to pay later.",
      parameters: {
        type: "object",
        properties: {
          dueAt: { type: "string", description: "Future ISO-8601 date/time for the customer's explicit commitment." },
          promisedAmount: { type: "number", description: "Promised amount in paise. Omit to use the outstanding amount." },
          note: { type: "string", description: "Short evidence note quoting or summarizing the explicit customer commitment." },
        },
        required: ["dueAt"],
        additionalProperties: false,
      },
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

interface LiveRecoveryContext {
  caseStatus: string | null;
  rootCause: string | null;
  confidence: number | null;
  planVersion: number | null;
  planTrigger: string | null;
  planObjective: string | null;
  primaryAction: string | null;
  fallbackAction: string | null;
  planReasoning: string | null;
  automatedRetryCount: number;
  contactsLast24h: number;
  pendingPromise: null | {
    promisedAmount: number;
    dueAt: string;
    note: string | null;
  };
}

async function loadLiveRecoveryContext(eventId: string, customerEmail: string): Promise<LiveRecoveryContext> {
  const [contextResult, policyContext] = await Promise.all([
    pool.query(
      `SELECT
         rc.status AS case_status,
         d.root_cause,
         d.confidence,
         rp.version AS plan_version,
         rp.trigger AS plan_trigger,
         rp.objective AS plan_objective,
         rp.primary_action,
         rp.fallback_action,
         rp.reasoning AS plan_reasoning,
         pp.promised_amount,
         pp.due_at,
         pp.note AS promise_note
       FROM recovery_cases rc
       LEFT JOIN LATERAL (
         SELECT root_cause, confidence
         FROM diagnoses
         WHERE event_id = rc.original_event_id
         ORDER BY id DESC LIMIT 1
       ) d ON true
       LEFT JOIN LATERAL (
         SELECT version, trigger, objective, primary_action, fallback_action, reasoning
         FROM recovery_plans
         WHERE case_id = rc.id
         ORDER BY version DESC LIMIT 1
       ) rp ON true
       LEFT JOIN LATERAL (
         SELECT promised_amount, due_at, note
         FROM payment_promises
         WHERE case_id = rc.id AND status = 'PENDING'
         ORDER BY due_at ASC LIMIT 1
       ) pp ON true
       WHERE rc.original_event_id = $1`,
      [eventId]
    ),
    loadPolicyContext(pool, { eventId, customerEmail }),
  ]);

  const row = contextResult.rows[0] ?? {};
  return {
    caseStatus: row.case_status == null ? null : String(row.case_status),
    rootCause: row.root_cause == null ? null : String(row.root_cause),
    confidence: row.confidence == null ? null : Number(row.confidence),
    planVersion: row.plan_version == null ? null : Number(row.plan_version),
    planTrigger: row.plan_trigger == null ? null : String(row.plan_trigger),
    planObjective: row.plan_objective == null ? null : String(row.plan_objective),
    primaryAction: row.primary_action == null ? null : String(row.primary_action),
    fallbackAction: row.fallback_action == null ? null : String(row.fallback_action),
    planReasoning: row.plan_reasoning == null ? null : String(row.plan_reasoning),
    automatedRetryCount: policyContext.automatedRetryCount,
    contactsLast24h: policyContext.contactsLast24h,
    pendingPromise: row.promised_amount == null ? null : {
      promisedAmount: Number(row.promised_amount),
      dueAt: new Date(row.due_at).toISOString(),
      note: row.promise_note == null ? null : String(row.promise_note),
    },
  };
}

function buildSystemPrompt(customerEmail: string, amount: number, context: LiveRecoveryContext): string {
  const now = new Date().toISOString();
  const timezone = process.env.RECOVERY_TIMEZONE || "Asia/Kolkata";
  const plan = context.planVersion == null
    ? "No durable recovery plan has been persisted yet."
    : `Plan v${context.planVersion} (${context.planTrigger}): objective=${context.planObjective}; primary=${context.primaryAction}; fallback=${context.fallbackAction}; reasoning=${context.planReasoning}`;
  const promise = context.pendingPromise
    ? `Active Promise-to-Pay: ${context.pendingPromise.promisedAmount} paise due ${context.pendingPromise.dueAt}${context.pendingPromise.note ? `; note=${context.pendingPromise.note}` : ""}`
    : "No active Promise-to-Pay.";

  return `You are the customer-facing tool-using recovery agent inside Recovery OS.

Known trusted context:
- Customer email: ${customerEmail}
- Amount due: ${amount} paise (₹${(amount / 100).toFixed(2)})
- Current server time: ${now}
- Merchant recovery timezone: ${timezone}
- Recovery case status: ${context.caseStatus ?? "unknown"}
- Verified diagnosis: ${context.rootCause ?? "not available"} (confidence ${context.confidence ?? "n/a"})
- Automated retry attempts already made: ${context.automatedRetryCount}
- Recovery contacts in the last 24h: ${context.contactsLast24h}
- ${plan}
- ${promise}

This conversation is a live business-observation step in the same recovery loop. Interpret genuine customer intent in light of the current plan; do not behave like a generic support chatbot.

Be brief and helpful. Tools request intents only; deterministic backend policy decides whether a side effect is allowed. Never ask the customer to provide an amount or identity that the backend already knows. Only use record_promise_to_pay when the customer explicitly commits to paying at a future time; do not infer a promise from uncertainty or vague intention. Convert a clear relative time such as "tonight at 8" into a future ISO-8601 time using the supplied merchant timezone. If the customer asks for an allowed recovery step, use the tool rather than merely describing it. Do not bypass contact/retry limits. Escalate instead of guessing.`;
}

async function getOrCreateConversation(eventId: string, customerEmail: string, amount: number) {
  const liveContext = await loadLiveRecoveryContext(eventId, customerEmail);
  const systemPrompt = buildSystemPrompt(customerEmail, amount, liveContext);
  const convoResult = await pool.query("SELECT id, messages FROM conversations WHERE event_id = $1", [eventId]);
  if (convoResult.rows.length > 0) {
    const messages = convoResult.rows[0].messages as any[];
    if (messages[0]?.role === "system") messages[0] = { role: "system", content: systemPrompt };
    else messages.unshift({ role: "system", content: systemPrompt });
    return { id: Number(convoResult.rows[0].id), messages, liveContext };
  }
  const messages: any[] = [{ role: "system", content: systemPrompt }];
  const inserted = await pool.query(
    "INSERT INTO conversations (event_id, messages) VALUES ($1, $2) RETURNING id",
    [eventId, JSON.stringify(messages)]
  );
  return { id: Number(inserted.rows[0].id), messages, liveContext };
}

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

export async function runAgentTurn(eventId: string, customerEmail: string, amount: number, userMessage: string) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const conversation = await getOrCreateConversation(eventId, customerEmail, amount);
  const messages = conversation.messages;

  messages.push({ role: "user", content: userMessage });
  await logAuditEvent(eventId, "customer_reply_observed", {
    message: userMessage,
    currentPlanVersion: conversation.liveContext.planVersion,
    currentPrimaryAction: conversation.liveContext.primaryAction,
    pendingPromise: conversation.liveContext.pendingPromise,
  });

  let response = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages,
    tools: TOOLS,
  });
  let assistantMessage = response.choices[0].message;
  messages.push(assistantMessage);

  const toolsUsed: string[] = [];
  while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments || "{}");
      toolsUsed.push(toolCall.function.name);
      let result: any;
      if (toolCall.function.name === "check_customer_risk_flags") {
        result = await checkCustomerRiskFlags(customerEmail);
      } else if (toolCall.function.name === "generate_payment_link") {
        result = await generatePaymentLink(eventId, amount);
      } else if (toolCall.function.name === "record_promise_to_pay") {
        result = await recordPromiseToPay(eventId, args.dueAt, args.promisedAmount ?? null, args.note ?? null);
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
  await logAuditEvent(eventId, "customer_reply_agent_result", {
    toolsUsed,
    assistantResponse: assistantMessage.content,
  });
  return assistantMessage.content;
}
