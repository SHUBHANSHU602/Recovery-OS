# Recovery OS — Engineering Decisions

This file contains only the important architecture and engineering decisions behind Recovery OS.

## Core design philosophy

- **AI handles ambiguity; deterministic code handles trust.**
  - The model diagnoses failure causes, creates recovery plans, and handles customer language.
  - Deterministic code verifies evidence, enforces policy, controls side effects, manages idempotency, and records money outcomes.
  - Why: a payment system should not allow an LLM to directly decide trusted identity, payment amount, retry limits, or recovered revenue.

- **Recovery is a business outcome, not an API result.**
  - A successful Payment Link API call is only execution success.
  - A case becomes `RECOVERED` only after a trusted `payment_link.paid` outcome is processed.
  - Why: creating a link or sending a message does not mean money was actually recovered.

- **Fail closed when state is uncertain.**
  - Ambiguous diagnoses, exhausted retry budgets, uncertain crash recovery, or unsafe customer-contact state move toward human review instead of more automation.
  - Why: payment-adjacent automation should prefer safety over duplicated or unjustified actions.

## Tech stack decisions

- **Node.js + TypeScript**
  - Used for webhook ingestion, API routes, background workers, AI calls, and provider integrations.
  - Why: Recovery OS is mostly I/O-bound and benefits from Node’s async model, while TypeScript gives explicit contracts around payment, policy, and recovery state.

- **Express**
  - Used for Razorpay webhooks, dashboard APIs, live merchant-console APIs, channel APIs, and local testing controls.
  - Why: the service needs a small, transparent HTTP layer rather than a large framework.

- **PostgreSQL**
  - Stores payment events, recovery cases, jobs, diagnoses, plans, actions, retries, conversations, promises, channel deliveries, escalations, and audit history.
  - Why: the problem is highly relational and transactional. Recovery state, idempotency, joins, locks, and durable queues fit PostgreSQL better than a document-only design.

- **Groq + `openai/gpt-oss-120b`**
  - Used for structured diagnosis, contextual recovery planning, replanning, and conversational reasoning.
  - Why: the project needs tool/function calling and strong reasoning, but the architecture keeps model output bounded by deterministic verification and policy.

- **Razorpay Test Mode**
  - Used for Payment Link execution and trusted payment outcome handling during development and validation.
  - Why: it exercises real payment-provider integration behavior without production money movement.

- **Resend + Twilio adapters**
  - Resend handles email when configured.
  - Twilio handles SMS, WhatsApp, and voice when configured.
  - Why: channel delivery should use dedicated provider adapters while sharing one recovery-policy boundary.

- **Plain orchestration instead of LangGraph**
  - Recovery flow is implemented with explicit services, state tables, and workers.
  - Why: the workflow is understandable and auditable without introducing a graph framework for orchestration that is already well represented by durable state transitions.

- **No vector database / RAG**
  - Recovery decisions use structured payment evidence from PostgreSQL.
  - Why: error codes, payment history, bank correlation, retries, contacts, and outcomes are structured data, not semantic-document retrieval problems.

## Webhook and trust-boundary decisions

- **Verify webhook signatures before trusting payloads.**
  - Raw request bodies are checked with HMAC-SHA256 and `timingSafeEqual`.
  - Why: event IDs alone do not prove that a webhook came from the trusted payment provider.

- **Separate webhook receipt from webhook completion.**
  - `webhook_deliveries` tracks `RECEIVED`, `PROCESSING`, `PROCESSED`, and `FAILED`.
  - Why: a webhook can be persisted successfully while later processing fails; retries must be able to resume that work.

- **Use one checked-out PostgreSQL client for transactions.**
  - `pool.connect()` owns each multi-step transaction.
  - Why: separate `pool.query()` calls are not guaranteed to run on the same connection.

## Recovery-state decisions

- **One durable recovery case per original failed payment.**
  - `recovery_cases` is the main business object for status, amount at risk, strategy, provider link, terminal reason, and recovered amount.
  - Why: diagnosis/action rows can change over time, but the original failed payment needs one stable business identity.

- **Use durable recovery jobs rather than processing everything inside the webhook request.**
  - A trusted failed-payment webhook creates a recovery job.
  - Why: the recovery pipeline should survive restarts and not depend on one HTTP request staying alive.

- **Treat the original payment succeeding as terminal.**
  - Trusted `payment.captured` moves the case to `STOPPED`, not `RECOVERED`.
  - Why: recovery must stop immediately, but that money should not be attributed to a Recovery OS Payment Link.

## Evidence and diagnosis decisions

- **Evidence is bounded by event time.**
  - Customer history and same-bank correlation only include failures that happened before the current event.
  - Why: future information must not leak into earlier decisions.

- **Diagnosis is constrained to a small allowed cause set.**
  - `insufficient_funds`
  - `expired_card`
  - `systemic_bank_outage`
  - `ambiguous`
  - Why: a bounded schema makes model behavior testable and keeps downstream policy predictable.

- **A deterministic verifier runs after the model.**
  - It checks whether the diagnosis is consistent with observable evidence.
  - Why: the model’s confidence is not enough to authorize automated recovery.

## Recovery-planner decisions

- **Use a structured, versioned recovery plan instead of a one-shot action guess.**
  - Every plan contains an objective, primary action, fallback action, reasoning, escalation criteria, and stop conditions.
  - Why: recovery is a multi-step business process, and plan history should be visible and auditable.

- **Allowed automated actions are bounded.**
  - `retry_now`
  - `retry_with_backoff`
  - `offer_alternate_payment_method`
  - `whatsapp_nudge`
  - `escalate_to_human`
  - Why: the AI should reason inside an approved action surface instead of inventing side effects.

- **Deterministic business guardrails sit after AI planning.**
  - Examples: exhausted retries escalate, low-confidence ambiguity escalates, Promise-to-Pay contact rules are enforced, and failed prior strategies can trigger a change in approach.
  - Why: AI can choose strategy, but stable business invariants should not depend on model wording.

- **Planner inference uses temperature `0`.**
  - Why: recovery decisions should be reproducible and benchmarkable instead of changing randomly between equivalent runs.

- **Replanning is triggered by business outcomes, not infrastructure errors.**
  - Unresolved interventions, customer replies, or overdue Promise-to-Pay commitments can cause replanning.
  - 429/5xx/network failures stay in deterministic execution retry logic.
  - Why: transport reliability and customer/payment intent are different problems.

- **Historical outcomes are decision context, not model retraining.**
  - The planner can see SQL-aggregated strategy outcomes and prior customer recovery results.
  - Why: useful memory can improve context without claiming continuous learning or online model training.

## Policy decisions

- **The policy gate is authoritative.**
  - It enforces automated retry caps, customer contact caps, terminal-state rules, and safe escalation behavior.
  - Why: business safety rules must remain deterministic even when the AI recommendation changes.

- **Policy reads live persisted state.**
  - Retry count, recent contacts, terminal state, and other constraints come from PostgreSQL.
  - Why: hard-coded counters or prompt-only limits are not trustworthy in a restartable system.

## Side-effect and idempotency decisions

- **All money-adjacent side effects pass through one ActionService.**
  - Automated and conversational Payment Link requests use the same execution boundary.
  - Why: there should be one place to enforce trusted data reload, policy, idempotency, provider calls, and durable result recording.

- **Idempotency belongs to the logical action attempt.**
  - Keys include stable failed-payment identity, action, and attempt number.
  - Why: database row IDs change on reruns, while action-only identity is too broad for legitimate later retries.

- **Claim the action before the provider call.**
  - PostgreSQL `INSERT ... ON CONFLICT DO NOTHING` reserves the logical attempt before Razorpay execution.
  - Why: check-then-call idempotency is vulnerable to concurrent duplicate requests.

- **Do not blindly replay an ambiguous claimed external action after a crash.**
  - Create human escalation instead.
  - Why: PostgreSQL and an external API cannot provide one atomic exactly-once transaction together.

## Retry and scheduling decisions

- **Backoff is persisted, not implemented with in-memory sleeps.**
  - `scheduled_actions` stores future work and a polling worker claims due jobs.
  - Why: in-memory timers disappear when the process restarts.

- **Respect provider retry signals.**
  - Honor `Retry-After` when available; otherwise use bounded exponential backoff and deterministic jitter for transient failures.
  - Why: retry behavior should cooperate with the provider and avoid synchronized retry storms.

- **Automated retries are capped.**
  - After the limit is exhausted, create a durable human escalation.
  - Why: repeated automated attempts should not continue indefinitely.

## Conversation decisions

- **Conversation uses the same trusted recovery context as automation.**
  - Each customer turn is provided the latest verified diagnosis, recovery plan, contact/retry state, and Promise-to-Pay state.
  - Why: the conversational agent should be part of the recovery loop, not a disconnected chatbot.

- **Trusted identity and amount remain backend-owned.**
  - The model cannot redefine who the customer is or how much is owed.
  - Why: financial state must come from trusted persisted data.

- **Tool calls reuse existing policy-gated services.**
  - Payment Link generation, Promise-to-Pay, risk checks, and human escalation go through backend services.
  - Why: conversational AI should not create a second unsafe execution path.

## Promise-to-Pay decisions

- **A Promise-to-Pay is durable workflow state.**
  - Store amount, due time, source, status, and reminder work.
  - Why: “I will pay tomorrow” should survive process restarts and be tracked like a business commitment.

- **Only explicit commitments create a promise.**
  - Vague intent is not enough.
  - Why: the model must not manufacture a financial commitment from uncertain language.

- **Only one active pending promise per case.**
  - Replacing a promise cancels the old promise and its pending reminder before creating the new one.
  - Why: stale reminders must not act on superseded commitments.

- **Trusted payment success fulfills the promise and cancels future work.**
  - Why: once payment is confirmed, all recovery automation should stop.

## Omnichannel decisions

- **Email, SMS, WhatsApp, and voice share one channel service.**
  - Why: each channel should obey the same terminal-state, quiet-hours, contact-cap, and trusted-data rules.

- **Customer contact capacity is reserved before provider execution.**
  - A per-customer PostgreSQL advisory lock protects the 24-hour cap from concurrent sends.
  - Why: check-then-send logic can allow two requests to contact the customer at the same time.

- **Quiet hours are enforced deterministically.**
  - Automated outreach can be deferred; manual outreach is blocked until the allowed window.
  - Why: contact compliance should not live inside an AI prompt.

- **Channel delivery never changes recovered revenue.**
  - Why: a sent email, SMS, WhatsApp message, or voice call is communication activity, not a payment outcome.

## Audit and observability decisions

- **Keep an append-only audit trail of important recovery stages.**
  - Diagnosis, verification, planning, policy, action execution, outcome handling, and escalation are recorded.
  - Why: payment recovery needs explainability and post-incident traceability.

- **Enforce append-only behavior inside PostgreSQL.**
  - A trigger rejects normal `UPDATE` and `DELETE` on `audit_log`.
  - Why: application convention alone is too weak.

- **Use precise terminology.**
  - Call it a **database-enforced append-only audit trail**, not a cryptographically immutable ledger.
  - Why: the guarantee should match what the system actually enforces.

## Evaluation decisions

- **Keep model-quality benchmarks separate from revenue outcomes.**
  - `evaluate:ai` measures contextual decision quality.
  - The competitive 500-case benchmark is synthetic/counterfactual.
  - Trusted paid outcomes are the source of recovery accounting.
  - Why: model accuracy, simulated lift, and actual payment outcomes are different evidence classes.

- **Compare AI and static rules with the same deterministic policy gate.**
  - Why: the AI should only get credit for better contextual planning, not for safety rules that deterministic code already provides.

- **Use fixed seeds for synthetic benchmarks.**
  - Why: benchmark results should be reproducible.

- **Ground truth is causal.**
  - An outage label is only used when enough earlier evidence existed at decision time.
  - Why: an evaluation should not reward a system for knowing the future.

## Repository and CI decisions

- **Keep the repository reproducible.**
  - Standard root layout, `.env.example`, Docker Compose, ordered SQL migrations, migration runner, valid `package.json`, and no tracked `node_modules`.
  - Why: a reviewer should be able to clone and understand how the system is started and tested.

- **Aggregate tests must include every intended subsystem.**
  - `test:core` includes typecheck, policy, verifier, dashboard, intelligence, channels, competitive benchmark, and final AI tests.
  - Why: a green command is only meaningful when the full intended suite is actually included.

- **The live merchant console is a read/operate layer over persisted recovery state.**
  - It shows case status, plan history, audit activity, conversations, scheduled work, Promise-to-Pay, and guarded test actions.
  - Why: judges and operators need to see the recovery loop as a live system rather than only reading terminal logs.