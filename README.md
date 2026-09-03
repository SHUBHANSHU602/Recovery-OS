# Recovery OS

**Closed-loop AI revenue recovery for failed payments** — built for Razorpay's AI Buildathon, Track 3.

Recovery OS detects failed payments, gathers causal evidence, uses an LLM to diagnose the likely cause, verifies that diagnosis deterministically, chooses a bounded intervention, applies hard policy limits, executes through a centralized action service, and records confirmed recovered revenue only after a trusted Razorpay outcome webhook.

> **AI handles ambiguity and language. Deterministic code handles trust, policy, side effects, idempotency, and money accounting.**

## Core loop

```text
trusted payment.failed webhook
        ↓
webhook inbox: RECEIVED → PROCESSING → PROCESSED / FAILED
        ↓
durable recovery case + recovery job
        ↓
causal evidence snapshot
        ↓
LLM diagnosis
        ↓
deterministic verifier
        ↓
LLM intervention selection from a fixed menu
        ↓
deterministic policy gate
        ↓
ActionService
   ├─ retry_now
   ├─ scheduled retry_with_backoff
   ├─ simulated conversational outreach
   └─ durable human escalation
        ↓
Razorpay Test Mode Payment Link
        ↓
payment_link.paid webhook
        ↓
RECOVERED + recovered_amount
```

A later `payment.captured` for the original payment is also treated as a terminal signal so Recovery OS stops asking a customer to pay again.

## What makes the design different

### 1. Revenue recovery is measured from confirmed outcomes

Creating a Payment Link is **execution success**, not revenue recovery.

Recovery OS keeps one `recovery_cases` row per original failed transaction and reports:

- revenue at risk
- confirmed recovered revenue
- value recovery rate
- transaction recovery rate
- unresolved amount
- recovery by strategy

Only a trusted `payment_link.paid` webhook can move an open case to `RECOVERED` and increase `recovered_amount`.

### 2. Webhooks are authenticated and retry-safe

The Razorpay webhook route:

1. preserves the raw request body,
2. verifies `X-Razorpay-Signature` using HMAC-SHA256,
3. stores the event and a durable webhook-delivery state,
4. separates **received** from **fully processed**, and
5. allows failed/stale processing to be reclaimed safely.

This avoids the common bug where an event ID is deduplicated before downstream processing succeeds and a Razorpay retry is then incorrectly discarded as "already processed".

### 3. Evidence is decision-time safe

Diagnosis only sees evidence that existed **before the failed payment being diagnosed**.

Customer history and same-bank correlation queries end at the event timestamp. Future failures cannot leak backward into an earlier decision.

### 4. AI is advisory; policy remains authoritative

The diagnosis model is constrained to:

- `insufficient_funds`
- `expired_card`
- `systemic_bank_outage`
- `ambiguous`

A deterministic verifier independently checks whether the evidence supports the model's claim.

The intervention model can only select:

- `retry_now`
- `retry_with_backoff`
- `offer_alternate_payment_method`
- `whatsapp_nudge`
- `escalate_to_human`

It receives richer context than just the root cause: value at risk, prior failed payments, bank-correlation evidence, retry/contact state, and prior recovery outcomes. The deterministic policy gate still has final authority.

### 5. Backoff is real persisted work

`retry_with_backoff` no longer means "create a link immediately." It creates a durable `scheduled_actions` row with a future `run_at`.

The worker:

- claims due work atomically,
- uses per-attempt idempotency identities,
- honors `Retry-After` when available,
- otherwise uses bounded exponential backoff plus deterministic jitter,
- retries transient `429` / `5xx` failures,
- stops at the configured retry cap, and
- creates a durable human-escalation item when automated recovery is exhausted or unsafe.

### 6. Idempotency is per execution attempt

The original implementation discovered a real test-mode duplicate-link bug because the idempotency key was tied to a database row ID instead of stable work identity.

The hardened design separates:

```text
recovery strategy
        ↓
logical attempt #1 / #2 / #3
        ↓
unique idempotency key for that exact attempt
```

That blocks concurrent duplicate execution of one attempt without accidentally blocking a legitimate later retry attempt.

If a previous exact attempt is found in an ambiguous `pending` state after a crash, Recovery OS fails closed and escalates rather than blindly issuing another money-adjacent external call.

### 7. Conversation tools use the same trust boundary

The conversational agent cannot directly choose trusted identity or amount values and cannot bypass policy.

Its `generate_payment_link` tool calls the same `ActionService` used by the automated path. Trusted customer/amount data is reloaded from the stored payment event immediately before execution.

Outbound Recovery OS messages are stored as `assistant` messages; only real customer replies are stored as `user` messages.

### 8. Human escalation is durable

Escalation is not just an audit string. Recovery OS creates a `human_escalations` work item tied to the recovery case, with lifecycle state that can later be resolved by an operator flow.

### 9. Audit records have a database append-only guard

Every decision stage writes to `audit_log`.

A PostgreSQL trigger rejects `UPDATE` and `DELETE` against that table, giving the application a database-enforced append-only audit trail.

```sql
SELECT stage, detail, created_at
FROM audit_log
WHERE event_id = '...'
ORDER BY created_at;
```

## Evaluation design

The synthetic batch contains both clear controls and deliberately context-dependent cases.

Several events now use the **same** outward signal:

```text
GATEWAY_ERROR
"Payment could not be processed"
```

An isolated occurrence is labeled `ambiguous`. Later occurrences at the same bank become `systemic_bank_outage` only after enough earlier same-bank failures actually exist in the causal evidence window.

This makes an error-code lookup table insufficient and prevents future-information leakage from inflating diagnosis accuracy.

The evaluator reports diagnosis accuracy, verifier interventions, confirmed recovered revenue, transaction/value recovery, execution reliability, false escalation rate, recovery by strategy, and durable human-escalation count.

Because the evaluation labels and recovery accounting were hardened, **old headline numbers such as 96% diagnosis accuracy and 67.6% "recovery" are intentionally not carried forward**. Run the current evaluator against the current schema/data before publishing new metrics.

## Local setup

```bash
git clone https://github.com/SHUBHANSHU602/Recovery-OS.git
cd Recovery-OS

cp .env.example .env

docker compose up -d
npm install
npm run db:migrate
npm run typecheck
npm run test:core
npm start
```

The dependency versions in `package.json` are pinned. Generate and commit a fresh lockfile after the first validated local install; the stale pre-hardening lockfile was deliberately removed rather than left inconsistent with the repaired manifest.

Fill these values in `.env` before exercising external integrations:

```env
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
GROQ_API_KEY=
```

Run the evaluation with:

```bash
npm run evaluate
```

## Tech stack

| Choice | Why |
|---|---|
| Node.js + TypeScript | Good fit for webhook/API/DB-heavy I/O with explicit type boundaries |
| PostgreSQL | Recovery state, policy context, evidence correlation, durable jobs, and auditability are relational problems |
| Groq / `openai/gpt-oss-120b` | Structured diagnosis and intervention reasoning behind provider-independent interfaces |
| Razorpay Test Mode | Real Payment Link API execution and trusted outcome webhooks without moving production money |
| Plain orchestration | The core flow is understandable enough to audit without adding a graph framework |
| No vector DB / RAG | The evidence is structured payment state, not semantic document retrieval |

## Repository map

```text
src/
  ingestion/     trusted webhook boundary
  evidence/      causal evidence collection + synthetic batch
  diagnosis/     constrained LLM diagnosis
  verifier/      deterministic evidence invariants
  policy/        intervention choice + deterministic limits
  execution/     ActionService + delayed scheduler
  recovery/      case/job state machine
  agent/         tool-using conversation flow
  evaluation/    business + model metrics
  ledger/        audit logging
  db/            migration runner

sql/              reproducible schema
DEBUG.md          genuine bugs, symptoms, root causes, fixes
DECISION.md       architecture decisions and trade-offs
```

## Engineering record

The project deliberately keeps the debugging trail rather than presenting a fake "everything worked first try" story. `DEBUG.md` records genuine failures and their fixes, including the duplicate Payment Link bug, causal-evidence leakage, webhook-processing idempotency, retry-attempt identity, and transaction/pool mistakes found during hardening.

`DECISION.md` records the architectural decisions and trade-offs behind the current design.
