### ALL THE IMPORTANT DECISIONS ARE STORED HERE
---

- All amounts stored/handled in paise (Razorpay's native unit); convert to rupees only at display time.
- ts-node failed to resolve entry file on Windows/Node 24 (MODULE_NOT_FOUND on a valid path); tsx hit a separate ESM resolution error on the same setup; switched Day-1 webhook receiver to plain CommonJS JS to unblock, deferred TypeScript to Day 4 when structured-output validation actually needs it.
- Expected error_code to reflect the specific test-card scenario (payment_timed_out); got generic BAD_REQUEST_ERROR/payment_failed instead — test-mode manual Failure click doesn't preserve the card's intended error type.

# Decisions Log

## Day 1
- LLM provider: Anthropic Claude — matches Razorpay's own stack (Agent Studio built on Claude Agent SDK, NPCI agentic-payments pilot runs on Claude).
- Language/runtime: Node.js — I/O-bound service (webhooks, DB, LLM calls) fits Node's async model; TypeScript deferred to Day 4 (see below).
- TypeScript deferred for Day 1: ts-node and tsx both hit unresolved Windows/Node-24 module resolution errors on this machine. Day 1's webhook receiver is trivial and doesn't need type safety yet — switched to plain CommonJS JS to stay unblocked. Revisit TypeScript on Day 4 when structured LLM output validation actually needs it.
- Orchestration: plain hand-rolled pipeline, not LangGraph — the loop is linear with one branch (escalation); a framework built for complex multi-agent graphs is unnecessary complexity here.
- Memory/retrieval: no vector DB — diagnosis works off structured evidence (error codes, correlated failures, payment history), which is a SQL problem, not semantic search.
- Deployment: Docker Compose, local — buildathon asks for a public repo + pitch video + architecture doc, not confirmed live hosting.

## Day 2
- TypeScript brought in now (originally planned for Day 4) — user requested it early for the DB layer; switched from ts-node (broken on Day 1) to tsx, which works cleanly.
- Schema: `events` table uses a SERIAL `id` as primary key + a separate UNIQUE `event_id` column, not event_id as PK directly — keeps internal identity independent of Razorpay's external ID scheme, useful if a second payment provider is ever added.
- Dedup enforced at the database level via UNIQUE constraint + catching Postgres error code 23505, not via an application-level "check then insert" — avoids a race-condition window between check and insert.
- Payload stored as JSONB (not fixed columns) — evidence-gathering/diagnosis field needs aren't fully known yet; JSONB preserves everything and stays queryable.
- Moved DB credentials from hardcoded values in server.ts to .env (via dotenv) + .gitignore — server.ts will be in a public repo.

## Day 3
- Evidence gathered per event: error code/description (from the event itself), customer failure history count, and correlated-failures-at-same-bank count within a 30-minute window — matches the three-signal design in the handoff doc.
- Synthetic batch generator (recovery_batches table) creates labeled events with a known ground-truth cause, so Day 4 diagnosis accuracy becomes a measurable metric instead of a guess.
- recovery_batches.event_id is a foreign key into events(event_id) — Postgres physically rejects an orphaned synthetic label, keeping ground-truth data always in sync with real event rows.

## Day 4
- LLM provider switched from Anthropic Claude to Google Gemini (gemini-3.6-flash) — practical constraint: Gemini key already available free, Anthropic API is paid. Original pitch angle ("matches Razorpay's Claude-based stack") no longer applies; architecture (evidence -> diagnosis -> verifier -> policy gate) is the actual differentiator.
- Diagnosis structured output enforced via Gemini's forced function-calling (functionCallingConfig.mode: "ANY" + allowedFunctionNames) — same role as tool_choice, guarantees root_cause is always one of four enum values.
- diagnose.ts and gatherEvidence.ts both export their core functions so diagnoseBatch.ts (and later scripts) reuse the same logic rather than duplicating it — avoids evidence-gathering implementations drifting apart.
- Gemini free tier caps at 5 requests/minute for gemini-3.6-flash — added a 13s delay between diagnosis calls. Fine for real webhook events one at a time; batch evaluation should not rely on live uncached LLM calls.

## Day 5
- Verifier (verify.ts) is pure deterministic logic, zero API calls -- enforces: systemic_bank_outage requires >=2 correlated failures; customer-specific causes are flagged if correlation is actually systemic; confidence must be in [0,1]. Anything failing an invariant is downgraded to ambiguous.
- diagnoseBatch.ts stores verification.finalRootCause, not the raw LLM output -- makes the verifier's correction load-bearing.
- Known limitation: verifier checks evidence-consistency, not confidence calibration. It will not catch every plausible-but-wrong guess on thin evidence.

## Day 6
- chooseAction.ts: LLM selects one action from a fixed 5-action menu via forced function-calling — structurally cannot invent an unapproved action.
- policyGate.ts: pure deterministic logic, zero API calls. Enforces automated-attempt and contact caps that override the LLM.
- interventions table stores both chosen_action and final_action — preserves what the model wanted versus what policy allowed.
- Known simplification at this point: policy inputs were hardcoded in the batch path; isolated tests proved policy logic, but live wiring had not yet been completed.

## Day 7
- Added actions table and audit_log table — append-only application record of pipeline stages.
- auditLog.ts is the single logging path used by diagnosis, verification, intervention, policy and execution.
- execute.ts initially implemented retry_with_backoff as a real Razorpay test-mode payment-link call.
- Day 7 idempotency fix changed the business key from a surrogate intervention row ID to stable event + action identity.

## Day 8
- conversations table stores full message history as JSONB per event, status tracks active/resolved/escalated.
- Conversational agent uses a tool-calling while-loop, not a single LLM call.
- System prompt is built per-conversation with trusted customer context injected directly.
- Conversational payment links reused the Day 7 stable-idempotency idea.
- actions.intervention_id was made nullable because a conversational payment link may not map to a single automated intervention row.

## Day 9
- execute.ts routed whatsapp_nudge and offer_alternate_payment_method into the conversational agent.
- diagnoseBatch.ts accuracy is recomputed from stored diagnoses so skip-guards do not produce false 0% runs.

## Day 10
- Expanded batch_1 from 10 to 25 synthetic events: broader cause coverage, two independent outage clusters and a repeat-customer case.
- runEvaluation.ts originally reported diagnosis accuracy, verifier behavior, action-initiation success and false-escalation rate. Action initiation was explicitly caveated as not confirmed customer payment.

## Day 11 -- Track 3 hardening architecture decisions

### Decision 1: "Recovered revenue" means confirmed payment completion, never successful action initiation
**Problem:** A payment link can be created successfully while the customer never pays it. Calling that revenue recovered would optimize and report the wrong business outcome.

**Decision:** Introduce a separate `recoveries` outcome table. A failed payment only becomes recovered when Recovery OS receives and validates a payment-completion webhook that can be correlated back to the original failure. Evaluation keeps operational action success as a secondary metric, but the headline metrics are confirmed recovered rupees, recovered transactions and value-recovery rate.

**Correlation mechanism:** every Recovery OS-created Razorpay Payment Link carries `recovery_event_id` in Razorpay `notes`. This survives outside our database and gives the later Payment Link webhook a stable business identity to point back to.

**Trade-off:** old evaluation numbers are no longer directly comparable. That is intentional; correctness is more important than preserving a higher-looking metric.

### Decision 2: authenticate a webhook before parsing or persisting it
**Problem:** webhook payloads can trigger expensive or customer-facing recovery behavior, so `x-razorpay-event-id` deduplication alone proves uniqueness but not authenticity.

**Decision:** Razorpay webhook requests are received as raw bytes, HMAC-SHA256 verified against `X-Razorpay-Signature`, then JSON-parsed and inserted only after validation. The event-ID unique constraint remains responsible for duplicate delivery, while HMAC is responsible for sender authenticity.

**Trade-off:** this route can no longer use a global `express.json()` body parser before signature validation. Raw-body handling is slightly less convenient but required for correct signature verification.

### Decision 3: every policy decision must be built from real runtime state
**Problem:** a deterministic safety function is decorative if its callers feed placeholder values.

**Decision:** add `getPolicyRuntimeContext(eventId)` as the single source of policy facts. It loads prior customer failures that actually occurred before this event, payment-link attempts already created for this failed payment, recent customer contact and whether recovery has already completed.

**Why separate policy context from the policy gate:** querying data and deciding policy are different responsibilities. The gate stays a pure, easily testable function while the context loader handles database state.

### Decision 4: `stop_recovery` is a first-class policy outcome
**Problem:** once a payment has been recovered, the safest action is not another retry or escalation; it is to do nothing.

**Decision:** the LLM cannot choose `stop_recovery`, but the deterministic policy layer can override any proposed action with this terminal outcome when confirmed recovery already exists.

**Trade-off:** final actions are no longer exactly the same enum as LLM-selected actions. That difference is desirable because policy is intentionally more authoritative than the model.

### Decision 5: no LLM-facing tool is allowed to bypass policy just because it is conversational
**Problem:** the conversational `generate_payment_link` tool previously called Razorpay directly, creating a second execution path that bypassed the main policy gate.

**Decision:** the tool now requests policy approval using current backend state and then calls the same centralized payment-link executor as automated recovery. The LLM decides intent; backend code owns customer identity, amount, policy and side effects.

**Trade-off:** tool code is less self-contained, but there is one enforcement model instead of several inconsistent ones.

### Decision 6: claim idempotency in Postgres before the external side effect
**Problem:** `SELECT no existing action -> call Razorpay -> INSERT` is safe for sequential reruns but unsafe for two simultaneous workers. Both can pass the SELECT before either inserts.

**Decision:** `INSERT ... status='pending' ON CONFLICT DO NOTHING RETURNING id` is the execution claim. Only the winner may call Razorpay. The row is updated after the external call.

**Why this is stronger:** the database unique constraint now participates before money-adjacent external work, not afterward.

**Known boundary:** if Razorpay accepts a request but the process dies before the response/DB update, the local row can remain `pending`. A reconciliation job is a future reliability improvement; blindly retrying an ambiguous external request is intentionally avoided.

### Decision 7: one centralized payment-link executor owns Razorpay calls and 429 handling
**Problem:** payment-link creation existed in more than one code path and previously treated Test Mode throttling as a terminal failure.

**Decision:** automated and conversational recovery both use `executeRecoveryPaymentLink`. It owns database claiming, Razorpay credentials, recovery correlation notes, action status updates, audit events and bounded HTTP-429 backoff.

**Retry policy:** only explicit HTTP 429 responses are automatically retried. Arbitrary network failures are not blindly retried because the request might have reached Razorpay even if the response was lost.

### Decision 8: `retry_with_backoff` must be a schedule, not an immediate API call
**Problem:** immediate execution contradicted both the action name and the business rationale for a temporary bank outage.

**Decision:** write a due-time row to `scheduled_recovery_actions`. A worker claims due jobs and calls the centralized executor later. The default delay is configurable through `RECOVERY_BACKOFF_SECONDS` so local testing can use seconds instead of minutes.

**Trade-off:** this introduces another persisted state machine, but makes the recovery action semantically real and auditable.

### Decision 9: conversation start and customer reply are different domain events
**Problem:** the initial outbound Recovery OS message was passed into the LLM as `role: user`, making the model respond to its own intended message.

**Decision:** `startConversation()` stores the system prompt plus outbound opening as `role: assistant` without invoking the LLM. `runAgentTurn()` is only for an actual customer message.

### Decision 10: evaluation evidence must obey event time
**Problem:** an offline evaluator must not let a diagnosis see failures that happened after the payment being diagnosed, because the real-time service would not have known them yet.

**Decision:** customer history and bank-correlation evidence are restricted to timestamps earlier than the current failure. Bank correlation uses the preceding 30 minutes rather than an absolute plus/minus window.

**Trade-off:** some early events in a real outage cluster will be harder to diagnose and measured accuracy may fall. That is the honest behavior of a causal online system.

### Decision 11: webhook acknowledgement stays fast; recovery work runs after persistence
**Problem:** LLM diagnosis and external recovery calls can take seconds and should not hold Razorpay's webhook request open unnecessarily.

**Decision:** authenticate -> persist -> acknowledge, then invoke the single-event recovery pipeline. A failed payment runs evidence -> diagnosis -> verifier -> action selection -> policy -> execution. Payment-completion events go to the recovery-confirmation path instead.

**Known limitation / deliberate scope:** the post-ack handoff is currently process-local, not a durable queue. Because the event is persisted first, a crash does not lose the source event, but automatic processing may need replay. A durable queue/worker is the next reliability step if time permits.

### Decision 12: keep action attempts and financial outcomes as separate data models
**Problem:** one `actions` table cannot cleanly answer both "what did Recovery OS try?" and "how much money definitely came back?"

**Decision:** `actions` represents attempted side effects and conversations; `recoveries` represents externally confirmed business outcomes; `scheduled_recovery_actions` represents deferred work. `actions.event_id` is added so every new action has a direct, queryable link to the failed payment.

This separation makes three questions independently auditable: what the system decided, what it attempted, and what money was actually recovered.

### Decision 13: webhook replay must resume incomplete stages, not merely deduplicate storage
**Problem:** idempotent storage and idempotent business processing are different. If an event is inserted and the process dies after diagnosis but before intervention/execution, simply returning "already processed" on webhook replay turns the database row into a dead end. Likewise, treating "diagnosis exists" as "pipeline finished" loses the remaining work.

**Decision:** valid duplicate webhooks are allowed to re-enter the processing dispatcher without inserting another event row. `processRecoveryEvent()` is stage-resumable: it reuses an existing diagnosis, fills in a missing intervention, reuses an existing intervention, and always reaches the idempotent executor. A Postgres advisory lock keyed by the failed event ID serializes concurrent processing of the same payment failure.

**Why advisory locking instead of only another unique index:** older development data may already contain duplicate diagnosis rows, and adding a unique index safely would require cleanup across dependent foreign keys. The event-scoped lock gives immediate concurrency control without destructive migration of historical test data.

**Trade-off:** the lock is held while the event pipeline performs LLM/policy work, so one database connection remains occupied for that event. That is acceptable at current hackathon scale and safer than concurrent double-processing. A durable queued worker with explicit stage state would be the production-scale evolution.