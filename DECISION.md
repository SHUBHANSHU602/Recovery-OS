### ALL THE IMPORTANT DECISIONS ARE STORED HERE
---

- All amounts stored/handled in paise (Razorpay's native unit); convert to rupees only at display time.
- ts-node failed to resolve entry file on Windows/Node 24 (MODULE_NOT_FOUND on a valid path); tsx hit a separate ESM resolution error on the same setup; switched Day-1 webhook receiver to plain CommonJS JS to unblock, deferred TypeScript to Day 4 when structured-output validation actually needs it.
- Expected error_code to reflect the specific test-card scenario (payment_timed_out); got generic BAD_REQUEST_ERROR/payment_failed instead — test-mode manual Failure click doesn't preserve the card's intended error type.

# Decisions Log

## Day 1
- LLM provider: Anthropic Claude — matches Razorpay's own stack (Agent Studio built on Claude Agent SDK, NPCI agentic-payments pilot runs on Claude).
- Language/runtime: Node.js — I/O-bound service (webhooks, DB, LLM calls) fits Node's async model; TypeScript deferred to Day 4.
- TypeScript deferred for Day 1: ts-node and tsx both hit unresolved Windows/Node-24 module resolution errors on this machine. Day 1's webhook receiver is trivial and doesn't need type safety yet — switched to plain CommonJS JS to stay unblocked.
- Orchestration: plain hand-rolled pipeline, not LangGraph — the loop is linear with one branch (escalation); a framework built for complex multi-agent graphs is unnecessary complexity here.
- Memory/retrieval: no vector DB — diagnosis works off structured evidence (error codes, correlated failures, payment history), which is a SQL problem, not semantic search.
- Deployment: Docker Compose, local — buildathon asks for a public repo + pitch video + architecture doc, not confirmed live hosting.

## Day 2
- TypeScript brought in early for the DB layer; switched from ts-node to tsx.
- Schema: `events` uses a surrogate internal primary key plus a separate UNIQUE external `event_id`.
- Dedup enforced at the database level, not with a check-then-insert race.
- Raw webhook payloads stored as JSONB to preserve source data while requirements evolve.
- DB credentials moved to `.env` before public-repo use.

## Day 3
- Evidence per event: error code/description, customer failure history count, and same-bank correlated failures in a 30-minute window.
- Synthetic labeled batch created so diagnosis accuracy is measurable.
- `recovery_batches.event_id` references `events(event_id)` so labels cannot orphan from source events.

## Day 4
- LLM provider switched from Anthropic to Gemini due practical API access constraints at that stage; architecture remains provider-independent.
- Diagnosis structured output enforced through tool/function calling.
- Core functions exported and reused rather than duplicated across batch/single-event flows.
- Batch calls rate-limited deliberately rather than hiding provider free-tier constraints.

## Day 5
- Verifier is deterministic, zero-API logic. It checks evidence consistency, not semantic confidence calibration.
- Stored diagnosis is the verifier's final cause, making the verifier load-bearing rather than decorative.
- A known boundary was recorded: a claim can be evidence-consistent yet still be a poor confident guess on genuinely thin evidence.

## Day 6
- Action selection constrained to five approved actions via function calling.
- Policy gate remains deterministic and can override the model regardless of confidence.
- Interventions store both model choice and post-policy final action.

## Day 7
- Added `actions` and `audit_log` as durable side-effect/audit records.
- Centralized audit writes through one helper.
- Idempotency enforced with a database UNIQUE key before external execution.

## Day 8
- Conversations persist full message history as JSONB.
- Conversational agent uses a tool-calling loop, not a one-shot response.
- Known customer identity/amount are backend context, not values the LLM is allowed to redefine.
- `actions.intervention_id` made nullable because conversational actions may not belong to one automated intervention row.

## Day 9
- `whatsapp_nudge` and `offer_alternate_payment_method` enter the conversational path.
- Opening message remains deterministic; language reasoning begins on actual customer replies.
- Evaluation reads stored state rather than only work performed in the current process invocation.

## Day 10
- Expanded evaluation data to broaden cause coverage and include multiple bank clusters + repeat customers.
- Metrics initially included diagnosis accuracy, verifier interventions, action-initiation recovery proxy, and false escalation.

## Track 3 P0 hardening — 2026-09-02
- **Correctness baseline:** AI proposes; deterministic code verifies, gates, authorizes, executes, and accounts for money-adjacent actions.
- Added `recovery_cases` as the business-outcome identity keyed by original failed event.
- Action/API success no longer equals recovery. Trusted `payment_link.paid` is required to record recovered money.
- Added durable `recovery_jobs` so the webhook can hand off to a restartable pipeline.
- Webhook trust boundary moved to raw-body HMAC-SHA256 validation before parsing/persistence.
- Evidence is decision-time bounded; future events may not influence earlier decisions.
- Policy inputs come from persisted state instead of hard-coded placeholders.
- All payment-link creation uses one `ActionService` and reloads trusted amount/customer identity from the original event.
- Action rows are claimed before Razorpay calls to close the concurrent SELECT-before-call race.
- Conversational payment-link tools use the same ActionService and policy boundary.
- Opening recovery text is `assistant`/outbound; `user` is reserved for actual customer input.
- Evaluation separates execution reliability from confirmed money recovery.
- At P0 completion, delayed retry scheduling, 429 handling, DB-level audit protection, durable escalation work items, and reproducibility were intentionally left for P1 rather than overstated.

## Track 3 P1 hardening — 2026-09-02

### Webhook inbox semantics
- **Decision:** treat webhook transport receipt and business processing as separate states.
- Added `webhook_deliveries` with `RECEIVED`, `PROCESSING`, `PROCESSED`, and `FAILED`.
- A duplicate Razorpay event ID is only considered fully done when its delivery state is `PROCESSED`; failed or stale work may be reclaimed.
- Rationale: deduplicating at receipt time is insufficient because downstream processing can fail after persistence.

### PostgreSQL transactions must use one checked-out client
- **Decision:** any multi-statement transaction uses `pool.connect()` and a dedicated client for BEGIN/COMMIT/ROLLBACK.
- Rationale: `pool.query()` calls may use different physical connections, so transaction boundaries cannot safely be expressed with independent pool-level calls.

### Idempotency belongs to a logical attempt
- **Decision:** key payment-link side effects by recovery event + action + logical attempt number, not only by action name.
- Example: `event_retry_with_backoff_attempt_1`, `...attempt_2`, `...attempt_3`.
- Rationale: action-level identity blocked legitimate later retries; row-ID identity allowed duplicates. Attempt identity preserves both dedupe and retry semantics.

### Fail closed on ambiguous crash recovery
- **Decision:** if an exact action-attempt key already exists after a worker crash, do not blindly repeat the external side effect.
- Instead, surface the state as ambiguous and create a human escalation.
- Rationale: without a confirmed provider-side exactly-once primitive for this call, replaying an uncertain money-adjacent external action is less safe than escalating.

### Backoff must be persisted, not slept in-process
- **Decision:** `retry_with_backoff` creates `scheduled_actions` with `run_at` and is consumed by a polling worker.
- Rationale: in-memory timers/sleeps disappear on restart and hold execution resources unnecessarily.
- Transient retry policy: honor `Retry-After` when supplied; otherwise bounded exponential backoff + deterministic jitter; retry 429, 5xx, and network-style failures; cap automated attempts at three.

### Original payment success is terminal but not “recovered by Recovery OS”
- **Decision:** trusted `payment.captured` for the original payment moves an open recovery case to `STOPPED`, not `RECOVERED`.
- Rationale: the customer has paid and outreach must stop, but attributing that money to a Recovery OS Payment Link would overclaim recovered revenue.

### Action selection gets contextual inputs; policy still owns limits
- **Decision:** action selection receives root cause, confidence, amount at risk, prior customer failures, same-bank evidence, current retry/contact state, and prior recovery outcomes.
- Rationale: a root-cause → action mapping was too close to a switch statement and did not justify an LLM.
- The deterministic policy gate remains authoritative and can reject the LLM recommendation.

### Evaluation labels are causal, not omniscient
- **Decision:** early observations in an emerging bank cluster are labeled `ambiguous` until enough *earlier* corroborating failures exist.
- Added same-error-text cases where only contextual history changes the expected diagnosis.
- Rationale: ground truth for a decision system must reflect what was knowable at decision time, not what became obvious later.

### Evaluation metrics invalidate stale headlines when the methodology changes
- **Decision:** remove old 96% / 67.6% README headlines after changing causal labels and recovered-money accounting.
- New numbers must come from rerunning the current evaluator on the current schema/data.
- Rationale: preserving old numbers after changing the definition would be misleading.

### Human escalation is a work item, not just a log line
- **Decision:** create `human_escalations` with one durable item per recovery case.
- Policy, scheduler, executor, and agent escalation paths all converge on this record.
- Rationale: an escalation that nobody can own/resolve is not an operational workflow.

### Audit log terminology and enforcement
- **Decision:** describe the audit trail as **database-enforced append-only**, not cryptographically immutable.
- Added a PostgreSQL trigger rejecting UPDATE and DELETE on `audit_log`.
- Rationale: this materially strengthens tamper resistance while keeping the wording precise; DB admins can still alter schema/disable triggers, so “immutable ledger” remains too strong.

### Repository structure and reproducibility
- **Decision:** flatten the application to the repository root and use standard `README.md`.
- Remove tracked `node_modules`; retain `.gitignore` protections.
- Restore a valid `package.json` and Node-oriented `tsconfig.json`.
- Add `.env.example`, `docker-compose.yml`, ordered SQL migrations, and `src/db/migrate.ts`.
- Rationale: a judge should be able to clone, install, start Postgres, migrate, type-check, and run without reconstructing hidden local state.

### Runtime verification claims
- **Decision:** do not claim P1 runtime/E2E success from the GitHub connector session.
- Static cross-file review and repository mutations are verified; local Postgres, Razorpay Test Mode, and Groq execution still need to be run in the user's environment.
- The repository now exposes explicit commands for that verification so results can be recorded after execution rather than inferred.

## Phase B — Recovery intelligence layer — 2026-09-04

### Expected recovery value is operational priority, not recovered revenue
- **Decision:** compute and persist a smoothed recovery probability plus `expected_recovery_value = amount_at_risk × probability` for prioritization.
- Historical provider-confirmed outcomes may influence the probability, but expected value is never added to recovered revenue.
- Rationale: merchants need to know which open cases deserve attention first without weakening the strict `payment_link.paid` accounting rule.

### Initial retry timing should reflect the diagnosed failure class
- **Decision:** the first durable `retry_with_backoff` schedule is root-cause aware; later transport/provider failures continue to use `Retry-After` or bounded execution backoff.
- Rationale: a bank outage, insufficient funds, and an expired card should not all be treated as the same timing problem.

### Quiet hours defer outreach instead of silently dropping it
- **Decision:** outbound recovery contacts are checked against a deterministic merchant timezone/contact window. During quiet hours, the intended contact becomes durable scheduled work for the next allowed window.
- Rationale: contact compliance belongs in deterministic execution policy, not in an LLM prompt or an in-memory timer.

### Promise-to-Pay is a durable recovery commitment
- **Decision:** customer payment promises are persisted with amount, due time, source, status, and an associated reminder job.
- Only one pending promise is active per recovery case; a replacement cancels the previous pending promise.
- A trusted recovery outcome fulfills the pending promise and cancels remaining scheduled work for that case.
- Rationale: "I will pay later" is not a chat message to forget; it is a financial workflow state that must survive restarts and stop once payment is confirmed.

### Phase boundaries remain explicit
- **Decision:** Phase B records/defer-schedules outbound contacts but does not pretend WhatsApp/SMS/email/voice are live provider integrations.
- Real channel delivery belongs to Phase C and will use the same policy and scheduling boundaries.
