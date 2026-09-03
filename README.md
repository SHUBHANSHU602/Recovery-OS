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

A case is counted as confirmed recovered only when the persisted outcome has all of the trusted recovery evidence:

- `status = RECOVERED`
- `recovered_amount > 0`
- `recovered_at IS NOT NULL`
- `razorpay_payment_link_id IS NOT NULL`
- `terminal_reason = trusted_payment_link_paid`

This prevents API success, Payment Link creation, or a manual state change from being misreported as recovered money.

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

`retry_with_backoff` creates a durable `scheduled_actions` row with a future `run_at`.

The worker:

- claims due work atomically,
- uses per-attempt idempotency identities,
- honors `Retry-After` when available,
- otherwise uses bounded exponential backoff plus deterministic jitter,
- retries transient `429` / `5xx` failures,
- stops at the configured retry cap, and
- creates a durable human-escalation item when automated recovery is exhausted or unsafe.

Runtime schema initialization is serialized and guarded with a PostgreSQL advisory lock, and worker polling is non-overlapping so concurrent workers do not race on schema/catalog updates.

### 6. Idempotency is per execution attempt

The hardened design separates recovery strategy from logical execution attempt identity so concurrent duplicate execution of one attempt is blocked without accidentally blocking a legitimate later retry.

If an exact attempt is found in an ambiguous `pending` state after a crash, Recovery OS fails closed and escalates rather than blindly issuing another money-adjacent external call.

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

Several events use the **same** outward signal:

```text
GATEWAY_ERROR
"Payment could not be processed"
```

An isolated occurrence is labeled `ambiguous`. Later occurrences at the same bank become `systemic_bank_outage` only after enough earlier same-bank failures actually exist in the causal evidence window.

This makes an error-code lookup table insufficient and prevents future-information leakage from inflating diagnosis accuracy.

Before calculating business recovery rates, the evaluator checks that every event in the evaluation batch has a durable `recovery_case`. If coverage is incomplete, it reports that recovery has **not yet been evaluated** instead of printing a misleading `0/0 = 0%` result.

Prepare and evaluate:

```bash
npm run evaluate:prepare
npm run evaluate
```

## Validated evaluation results — 2026-09-03

The current hardened evaluator was run locally with all 25 `batch_1` events materialized into durable recovery cases. Revenue is counted as recovered only after a trusted Razorpay `payment_link.paid` outcome is processed.

### Evaluation summary

| Metric | Validated result |
|---|---:|
| Evaluation batch | `batch_1` |
| Total payment events | **25** |
| Diagnosis accuracy | **24/25 (96.0%)** |
| Verifier interventions | **0/25** |
| Recovery-case coverage | **25/25 (100%)** |
| Revenue at risk | **₹14,960.69** |
| Provider-confirmed recovered revenue | **₹703.51** |
| Value recovery rate | **4.7%** |
| Transaction recovery rate | **1/25 (4.0%)** |
| Unresolved amount | **₹14,257.18** |
| False-escalation rate | **0/25 (0.0%)** |

### Recovery by strategy

| Strategy | Cases | Confirmed recoveries | Confirmed revenue |
|---|---:|---:|---:|
| `retry_with_backoff` | 8 | **1** | **₹703.51** |
| `whatsapp_nudge` | 5 | 0 | ₹0.00 |
| `offer_alternate_payment_method` | 6 | 0 | ₹0.00 |
| `unassigned` | 6 | 0 | ₹0.00 |
| **Total** | **25** | **1** | **₹703.51** |

### Execution reliability

| Execution metric | Result |
|---|---:|
| Total recorded execution attempts | **61** |
| Successful attempts | **34** |
| Unsuccessful attempts | **27** |
| Razorpay `Too many requests` responses | **15** |
| Razorpay Test Mode Payment Link limit responses | **12** |
| Other / unexplained execution failures | **0** |

The raw execution result is **34/61 completed attempts**. All 27 unsuccessful attempts in this evaluation were attributable to Razorpay Test Mode quota/rate-limit responses; no additional internal execution-failure category was observed.

### Razorpay Test Mode constraints observed during evaluation

| Constraint metric | Result |
|---|---:|
| Batch cases affected by Razorpay Test Mode quota/rate limits | **8/25** |
| Batch cases unaffected by those limits | **17/25** |
| Failed scheduled-action attempts inspected | **16** |
| Scheduled failures caused by Razorpay Test Mode / rate limiting | **16/16** |
| Other scheduled-action failure categories | **0** |

### Human escalation breakdown

| Escalation reason | Count | Interpretation |
|---|---:|---|
| Customer already reached outbound-contact limit | **13** | Safety/policy enforcement |
| Policy or agent escalation | **4** | Intentional human handoff |
| Scheduled retry exhaustion | **7** | Includes cases affected by Razorpay Test Mode limits |
| **Total durable escalation work items** | **24** | Mixed policy and execution outcomes |

## Provider-confirmed closed-loop recovery proof

A Razorpay **Test Mode** Payment Link created by Recovery OS was successfully paid for **₹703.51**. Razorpay delivered `payment_link.paid`, the webhook was processed successfully, and the corresponding recovery case transitioned to `RECOVERED`.

### Outcome evidence

| Recovery evidence | Observed value |
|---|---|
| Environment | Razorpay **Test Mode** |
| Amount at risk | **₹703.51** |
| Payment completed | **Yes** |
| Webhook event | `payment_link.paid` |
| Webhook processing status | **PROCESSED** |
| Webhook processing attempts | **1** |
| Webhook processing error | **None** |
| Recovery-case state after provider outcome | **`RECOVERED`** |
| Recovered amount | **₹703.51** |
| Recovery strategy | `retry_with_backoff` |
| Terminal reason | **`trusted_payment_link_paid`** |

### Closed-loop verification

| Stage | Verified outcome |
|---|---|
| Payment failure stored | ✅ |
| Durable recovery case created | ✅ |
| Recovery strategy selected | ✅ |
| Razorpay Payment Link created | ✅ |
| ₹703.51 Test Mode payment completed | ✅ |
| Razorpay emitted `payment_link.paid` | ✅ |
| Authenticated webhook processed | ✅ |
| Payment Link correlated to recovery case | ✅ |
| Case transitioned to `RECOVERED` | ✅ |
| `recovered_amount` updated to ₹703.51 | ✅ |
| Terminal reason recorded as `trusted_payment_link_paid` | ✅ |

### Runtime proof screenshot
<img width="687" height="202" alt="image" src="https://github.com/user-attachments/assets/db252e66-9d21-4fc9-a513-7f3f41428338" />


> **Note:** Razorpay Test Mode uses simulated funds. The ₹703.51 result demonstrates provider-confirmed end-to-end recovery behavior, not production monetary revenue.

### Recovery integrity rule

| Event / action | Counted as recovered revenue? |
|---|---|
| AI recommends retry | ❌ No |
| Retry job scheduled | ❌ No |
| Razorpay API request succeeds | ❌ No |
| Payment Link is created | ❌ No |
| Recovery message is sent | ❌ No |
| Customer opens Payment Link | ❌ No |
| Trusted Razorpay `payment_link.paid` is processed | ✅ **Yes** |

A recovery is included in the business metric only when all trusted outcome evidence is present:

| Required evidence | Requirement |
|---|---|
| Recovery state | `RECOVERED` |
| Recovered amount | Greater than `0` |
| Recovery timestamp | `recovered_at` present |
| Provider evidence | Razorpay Payment Link ID present |
| Terminal reason | `trusted_payment_link_paid` |

## Validated runtime checks

| Runtime check | Result |
|---|---|
| Fresh dependency install | 103 packages audited, 0 reported vulnerabilities |
| Ordered migrations | `001_base_schema.sql` and `002_track3_hardening.sql` applied |
| TypeScript typecheck | Passing |
| Deterministic policy tests | Passing |
| Deterministic verifier tests | Passing |
| Signed webhook simulation | `200 OK` |
| Durable retry scheduling | Attempt #2 and #3 exercised |
| Retry exhaustion | Durable escalation exercised |
| Human escalation work-item creation | Exercised |
| Server/background workers | Started with non-overlapping polling |
| Provider-confirmed Test Mode paid outcome | **₹703.51 recovered** |

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
```

Fill these values in `.env` before exercising external integrations:

```env
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
GROQ_API_KEY=
```

Start the server/worker:

```bash
npm start
```

Prepare and evaluate the batch:

```bash
npm run evaluate:prepare
npm run evaluate
```

The dependency versions in `package.json` are pinned. Generate and commit a fresh lockfile after the validated install so future environments can use the exact same dependency graph.

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

The project deliberately keeps the debugging trail rather than presenting a fake "everything worked first try" story. `DEBUG.md` records genuine failures and their fixes, including duplicate Payment Link creation, causal-evidence leakage, webhook-processing idempotency, retry-attempt identity, transaction/pool mistakes, environment/config mismatches, and worker/schema concurrency discovered during hardening.

`DECISION.md` records the architectural decisions and trade-offs behind the current design.
