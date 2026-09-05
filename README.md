# Recovery OS

**Closed-loop AI revenue recovery for failed payments.**

Recovery OS turns a failed payment into a durable recovery workflow instead of treating it as a one-time retry problem. It verifies the payment event, gathers causal evidence, diagnoses the likely reason, creates a contextual recovery plan, executes through deterministic safety controls, follows up with the customer, and records recovery only after a trusted payment outcome.

> **AI handles ambiguity, planning, and customer language. Deterministic systems handle trust, policy, side effects, idempotency, retries, and money accounting.**

---

## The problem

Payment failures are usually handled with generic retries, disconnected support flows, or simple rule tables. That breaks down when the correct next step depends on context: a bank outage should not be treated like insufficient funds, a customer who already received outreach should not be contacted repeatedly, an overdue Promise-to-Pay may require a different plan, and a successful API call must not be counted as recovered revenue.

Recovery OS solves this by keeping one durable recovery case per failed payment and continuously moving that case through evidence, diagnosis, planning, execution, follow-up, and trusted outcome handling.

---

## Validated proof

These are results that were actually exercised during local release validation:

| Validation | Result |
|---|---:|
| Razorpay Test Mode recovery confirmed by trusted `payment_link.paid` | **₹703.51 recovered** |
| Live Razorpay provider reconciliation | **10/10 links matched, 0 mismatches** |
| Paid-link accounting | **1/1 paid link correctly reconciled** |
| Unpaid-link accounting | **9/9 unpaid links excluded from recovered revenue** |
| Diagnosis accuracy on `batch_1` | **24/25 (96.0%)** |
| Durable recovery-case coverage | **25/25 (100%)** |
| Static rules + same policy gate | **9/12 (75.0%)** |
| AI planner + business guardrails + same policy gate | **12/12 (100.0%)**, repeated twice |
| Final signed closed-loop integration test | **PASS** |
| Database append-only audit guard | **UPDATE/DELETE blocked** |

The ₹703.51 result came from a Razorpay **Test Mode Payment Link** that reached the trusted paid-outcome path and moved its recovery case to `RECOVERED`. The provider reconciliation test then checked all 10 provider-created Test Mode links against Razorpay's current state: the paid link matched trusted recovered accounting, all 9 unpaid links remained excluded from recovered revenue, and the run completed with **0 mismatches**. The 12-scenario AI comparison measures contextual decision quality, not revenue lift.
<img width="626" height="425" alt="image" src="https://github.com/user-attachments/assets/e2903318-aa6b-4310-a5b0-a09f301c096a" />

---

## Core features

| Capability | What Recovery OS does |
|---|---|
| **Trusted webhook ingestion** | Verifies Razorpay webhook signatures from the raw body, persists delivery state, and safely retries failed/stale processing. |
| **Durable recovery cases** | Tracks amount at risk, current state, strategy, payment-link identity, terminal reason, confirmed recovered amount, and restartable recovery jobs. |
| **Causal evidence engine** | Uses provider error data, customer history, same-bank correlation, amount at risk, and prior outcomes while preventing future events from leaking into earlier decisions. |
| **AI diagnosis + deterministic verifier** | Groq produces a structured diagnosis (`insufficient_funds`, `expired_card`, `systemic_bank_outage`, or `ambiguous`); deterministic code checks whether the evidence actually supports it. |
| **Contextual AI planning and replanning** | Builds versioned plans from diagnosis, value at risk, retry/contact state, prior customer outcomes, historical strategy outcomes, previous plans, customer replies, and overdue promises. |
| **Deterministic policy gate** | Enforces retry caps, contact caps, quiet hours, terminal-state rules, ambiguous/low-confidence handling, Promise-to-Pay rules, and human-escalation conditions. |
| **ActionService + idempotency** | All payment-adjacent side effects pass through one execution boundary that reloads trusted payment data, rechecks policy, claims the logical attempt, and records provider results. |
| **Durable retry engine** | `retry_with_backoff` is stored scheduled work; workers honor `Retry-After` or bounded exponential backoff with deterministic jitter and stop after the retry limit. |
| **Conversational recovery agent** | Uses the same live case state as the automated planner and can generate a Payment Link, check risk flags, record an explicit Promise-to-Pay, or escalate to a human. |
| **Promise-to-Pay** | Persists a customer's explicit commitment, due time, amount, reminder work, replacement/cancellation logic, and fulfillment after trusted payment. |
| **Omnichannel recovery** | Shared channel layer for email, SMS, WhatsApp, and voice, with Resend/Twilio adapters plus the same quiet-hour, terminal-state, and customer contact-cap rules. |
| **Durable human escalation** | Creates a real operator work item when automation is blocked, exhausted, ambiguous, or unsafe to replay. |
| **Trusted recovery accounting** | A case becomes `RECOVERED` only after a trusted `payment_link.paid`; if the original payment succeeds instead, the case becomes `STOPPED`. |
| **Append-only audit trail** | Important recovery decisions are written to `audit_log`; a PostgreSQL trigger blocks normal `UPDATE` and `DELETE`. |
| **Live merchant console** | Auto-refreshing console for case state, plans, diagnosis, policy, actions, schedules, contacts, conversations, promises, escalation work, channel activity, and local test controls. |

The planner can choose only from the bounded action set `retry_now`, `retry_with_backoff`, `offer_alternate_payment_method`, `whatsapp_nudge`, or `escalate_to_human`. Every plan stores an objective, primary action, fallback action, reasoning, escalation criteria, and stop conditions.

---

## Architecture

```text
                         ┌──────────────────────────┐
                         │        Razorpay          │
                         │ payment.failed / paid    │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                    ┌──────────────────────────────────┐
                    │      Webhook Trust Boundary      │
                    │ HMAC validation + durable inbox  │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │       Recovery Case + Job        │
                    │      durable PostgreSQL state    │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │         Evidence Engine          │
                    │ history + correlation + outcomes │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │ AI Diagnosis → Deterministic     │
                    │ Verifier                         │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │      AI Recovery Planner         │
                    │ versioned plan + replanning      │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │ Deterministic Policy/Guardrails  │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │          ActionService           │
                    │ idempotency + trusted execution  │
                    └───────┬─────────┬─────────┬──────┘
                            │         │         │
                            ▼         ▼         ▼
                   Retry Scheduler  Agent   Human Escalation
                            │         │
                            └────┬────┘
                                 ▼
                     Recovery Channels / Payment Link
                                 │
                                 ▼
                       trusted payment outcome
                                 │
                       ┌─────────┴─────────┐
                       ▼                   ▼
                   RECOVERED            STOPPED
```

PostgreSQL is the system of record for events, webhook deliveries, recovery cases/jobs, diagnoses, versioned plans, interventions, actions, scheduled work, contacts, channel deliveries, conversations, payment promises, human escalations, and audit history. The merchant console reads the same durable state used by the workers and APIs.

---

## End-to-end recovery flow

```text
payment.failed
→ signature verification
→ durable webhook delivery
→ recovery case + job
→ causal evidence snapshot
→ AI diagnosis
→ deterministic verification
→ versioned AI recovery plan
→ deterministic policy gate
→ ActionService execution / scheduling
→ outreach, conversation, Promise-to-Pay, or retry
→ business outcome review / replanning when unresolved
→ trusted payment_link.paid
→ RECOVERED + recovered_amount + pending-work cancellation
```

If the **original payment** succeeds first, trusted `payment.captured` moves the case to `STOPPED` so Recovery OS does not ask the customer to pay twice.

---

## Why AI is useful here

A fixed mapping such as `insufficient_funds → message` or `bank_outage → retry_later` can handle the first decision, but real recovery changes over time. The correct next action may depend on whether a previous nudge failed, retry budget is exhausted, the customer has already been contacted, a Promise-to-Pay is overdue, or historical outcomes show another strategy works better.

Recovery OS gives those changing business signals to the planner, while deterministic policy remains authoritative. In the validated 12-scenario contextual benchmark, the static-rule baseline scored **9/12**, while the AI planner with the same policy controls scored **12/12 on two consecutive runs**.

---

## Recovery integrity

Recovery OS deliberately separates **execution success** from **money recovery**. A recommendation, scheduled retry, message send, successful provider API call, or Payment Link creation does not increase recovered revenue. Only a trusted paid outcome linked to the recovery case can do that.

A confirmed recovery therefore contains the recovery state, positive recovered amount, recovery timestamp, provider Payment Link identity, and the terminal reason `trusted_payment_link_paid`.

---

## Release validation

The release pass exercised the full core suite plus signed webhook validation, action idempotency, retry/backoff/rate-limit handling, retry exhaustion, quiet hours, human escalation, conversational tool calling, Promise-to-Pay replacement and overdue replanning, trusted `payment_link.paid → RECOVERED`, original `payment.captured → STOPPED`, the database append-only audit trigger, the final closed-loop integration path ending with the dashboard showing `RECOVERED`, and live provider reconciliation across all existing Razorpay Test Mode Payment Links.

The final integration proof followed:

```text
payment.failed
→ durable case/job
→ evidence
→ Groq diagnosis
→ deterministic verifier
→ AI recovery plan
→ deterministic policy
→ outbound recovery action
→ AI conversation
→ trusted payment_link.paid
→ RECOVERED
```

For the detailed failure history and engineering trade-offs, see [`DEBUG.md`](./DEBUG.md) and [`DECISION.md`](./DECISION.md).

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js + TypeScript | Async webhook/provider I/O with explicit payment-state contracts |
| HTTP | Express | Small and transparent API/webhook layer |
| Database | PostgreSQL | Transactions, joins, advisory locks, durable jobs, idempotency, and auditability |
| AI | Groq + `openai/gpt-oss-120b` | Structured diagnosis, planning, replanning, and conversation |
| Payments | Razorpay Test Mode | Payment Links and trusted paid-outcome webhooks |
| Email | Resend | Email delivery adapter |
| SMS / WhatsApp / Voice | Twilio | Shared messaging and voice adapters |
| Orchestration | Explicit services + durable workers | Easy to inspect, test, and reason about without a graph framework |

No vector database or RAG layer is used because the core evidence is structured payment state and relational history, not semantic document retrieval.

---

## Local setup

```bash
git clone https://github.com/SHUBHANSHU602/Recovery-OS.git
cd Recovery-OS
npm install
cp .env.example .env
```

Start PostgreSQL with Docker Compose or a native PostgreSQL installation, then run:

```bash
npm run db:migrate
npm run typecheck
npm run test:core
npm start
```

Configure external integrations in `.env` when needed:

```env
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
GROQ_API_KEY=
RESEND_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
```

Useful evaluation commands:

```bash
npm run evaluate
npm run evaluate:competitive
npm run evaluate:ai
npm run evaluate:provider
```

---

## Repository map

```text
src/
  ingestion/      webhook trust boundary + server
  evidence/       causal evidence collection
  diagnosis/      structured AI diagnosis
  verifier/       deterministic evidence checks
  policy/         hard recovery limits
  execution/      ActionService + retry scheduler
  recovery/       recovery case/job workflow
  agent/          AI planner + conversational tools
  intelligence/   prioritization, quiet hours, Promise-to-Pay
  channels/       email/SMS/WhatsApp/voice
  dashboard/      merchant console APIs
  evaluation/     batch, competitive, AI, and provider reconciliation tests
  ledger/         audit logging
  db/             migrations/runtime schema support

sql/              ordered PostgreSQL migrations
DEBUG.md          real bugs, root causes, fixes, results
DECISION.md       architecture and engineering decisions
SUBMISSION_EVIDENCE.md concise submission-facing validation summary
```

---

## Engineering principle

Recovery OS is designed around a strict boundary:

> **Let AI reason where the problem is ambiguous. Keep trust, safety, side effects, retries, idempotency, and recovered-money accounting deterministic.**
> ---
> For deeper engineering context: [`DEBUG.md`](./DEBUG.md) records the important bugs, root causes, fixes, and validation results; [`DECISION.md`](./DECISION.md) explains the architecture, technology choices, and trade-offs.

