# Recovery OS

**Closed-loop AI revenue recovery for failed payments.**

Recovery OS turns a failed payment into a durable recovery workflow instead of treating it as a one-time retry problem. It verifies the payment event, gathers causal evidence, diagnoses the likely reason, creates a contextual recovery plan, executes through deterministic safety controls, follows up with the customer, and records recovery only after a trusted payment outcome.

> **AI handles ambiguity, planning, and customer language. Deterministic systems handle trust, policy, side effects, idempotency, retries, and money accounting.**

---

## The problem

Payment failures are usually handled with generic retries, disconnected support flows, or simple rule tables. That breaks down when the correct next step depends on context: a bank outage should not be treated like insufficient funds, a customer who already received outreach should not be contacted repeatedly, an overdue Promise-to-Pay may require a different plan, and a successful API call must not be counted as recovered revenue.

Recovery OS keeps one durable recovery case per failed payment and moves that case through evidence, diagnosis, planning, execution, follow-up, and trusted outcome handling.

---

## Razorpay Test Mode provider proof

A fresh provider-validation run was executed against a separate Razorpay Test Mode merchant environment after the payment-link integrity hardening work.

| Provider validation | Result |
|---|---:|
| Razorpay Payment Links checked | **5** |
| Intentionally paid links | **4** |
| Paid links correctly reconciled | **4/4** |
| Unpaid control links | **1** |
| Unpaid links excluded from recovered revenue | **1/1** |
| Provider-backed recovered amount | **₹1,156.00** |
| Provider/local accounting mismatches | **0** |
| Final provider reconciliation | **PASS** |

The five Payment Links were created through Recovery OS using Razorpay Test Mode. Four were intentionally paid through the Razorpay-hosted Test Mode checkout. All four became trusted `RECOVERED` cases with matching paid provider state and recovered amount. The fifth link was intentionally left unpaid; it remained financially open with `₹0` recovered and was not falsely attributed as revenue.

```text
Provider links checked: 5
Provider-paid links: 4
Provider-unpaid links: 1
Paid links correctly reconciled: 4/4
Unpaid links not falsely attributed to recovered revenue: 1/1
Provider-backed recovered amount: ₹1156.00
Mismatches: 0
PROVIDER RECONCILIATION RESULT: PASS
```

> **Screenshot placeholder — add the Razorpay provider reconciliation PASS screenshot here before submission.**
>
> Suggested file path: `docs/provider-reconciliation-pass.png`

<!-- PROVIDER_RECONCILIATION_SCREENSHOT_PLACEHOLDER -->

This is a **controlled Test Mode integration validation**, not a production recovery-rate claim. The correct statement is that **4/4 intentionally paid test links were reconciled correctly**, while the unpaid control was not counted as recovered revenue.

---

## Other validated proof

These results were also exercised during local release validation:

| Validation | Result |
|---|---:|
| Earlier Razorpay Test Mode recovery confirmed by trusted `payment_link.paid` | **₹703.51 recovered** |
| Earlier live Razorpay provider reconciliation | **10/10 links matched, 0 mismatches** |
| Earlier paid-link accounting | **1/1 paid link correctly reconciled** |
| Earlier unpaid-link accounting | **9/9 unpaid links excluded from recovered revenue** |
| Diagnosis accuracy on `batch_1` | **24/25 (96.0%)** |
| Durable recovery-case coverage | **25/25 (100.0%)** |
| Static rules + same policy gate | **9/12 (75.0%)** |
| AI planner + business guardrails + same policy gate | **12/12 (100.0%)**, repeated twice |
| Final signed closed-loop integration test | **PASS** |
| Database append-only audit guard | **UPDATE/DELETE blocked** |

The 12-scenario AI comparison measures contextual decision quality, not revenue lift. The provider reconciliation results measure accounting and integration correctness, not customer conversion effectiveness.

---

## Core features

| Capability | What Recovery OS does |
|---|---|
| **Trusted webhook ingestion** | Verifies Razorpay webhook signatures from the raw body, persists delivery state, and safely retries failed/stale processing. |
| **Durable recovery cases** | Tracks amount at risk, current state, strategy, payment-link identity, terminal reason, confirmed recovered amount, and restartable recovery jobs. |
| **Payment Link history** | Stores every recovery Payment Link with lifecycle state instead of relying on only one current link. |
| **Duplicate-payment protection** | Enforces at most one locally `ACTIVE` recovery link per case and reuses provider-active links instead of blindly creating another payable link. |
| **Financial vs automation state** | Keeps financial outcome separate from automation lifecycle so escalation does not erase the ability to recognize a later trusted payment. |
| **Causal evidence engine** | Uses provider error data, customer history, same-bank correlation, amount at risk, and prior outcomes while preventing future events from leaking into earlier decisions. |
| **AI diagnosis + deterministic verifier** | Groq produces a structured diagnosis; deterministic code checks whether the evidence actually supports it. |
| **Contextual AI planning and replanning** | Builds versioned plans from diagnosis, value at risk, retry/contact state, prior outcomes, previous plans, customer replies, and overdue promises. |
| **Deterministic policy gate** | Enforces retry caps, contact caps, quiet hours, terminal-state rules, ambiguous/low-confidence handling, Promise-to-Pay rules, and human-escalation conditions. |
| **ActionService + idempotency** | All payment-adjacent side effects pass through one execution boundary that reloads trusted payment data, rechecks policy, claims the logical attempt, and records provider results. |
| **Durable retry engine** | Retry work is persisted and workers honor bounded backoff and retry limits. |
| **Conversational recovery agent** | Uses live case state and can create a Payment Link, check risk flags, record a Promise-to-Pay, or escalate to a human. |
| **Promise-to-Pay** | Persists a customer's commitment, due time, amount, reminder work, replacement/cancellation logic, and fulfillment after trusted payment. |
| **Omnichannel recovery** | Shared channel layer for email, SMS, WhatsApp, and voice with explicit live/simulation behavior. |
| **Durable human escalation** | Creates a real operator work item when automation is blocked, exhausted, ambiguous, or unsafe to replay. |
| **Trusted recovery accounting** | A case becomes `RECOVERED` only after a trusted paid outcome; original-payment success instead closes the financial case as `STOPPED`. |
| **Append-only audit trail** | Important recovery decisions are written to `audit_log`; a PostgreSQL trigger blocks normal `UPDATE` and `DELETE`. |
| **Live merchant console** | Auto-refreshing console for case state, proof, diagnosis, plans, actions, schedules, conversations, escalations, channels, and audit activity. |

The planner can choose only from the bounded action set `retry_now`, `retry_with_backoff`, `offer_alternate_payment_method`, `whatsapp_nudge`, or `escalate_to_human`.

---

## Architecture

```text
Razorpay payment.failed
        │
        ▼
Webhook trust boundary
HMAC verification + durable inbox
        │
        ▼
Recovery case + job
        │
        ▼
Causal evidence engine
        │
        ▼
AI diagnosis
        │
        ▼
Deterministic verifier
        │
        ▼
AI recovery planner / replanner
        │
        ▼
Deterministic policy gate
        │
        ▼
ActionService
idempotency + provider execution
        │
        ├── retry / backoff
        ├── outreach / conversation
        ├── Promise-to-Pay
        └── human escalation
        │
        ▼
Razorpay Payment Link
        │
        ▼
trusted payment_link.paid
        │
        ▼
RECOVERED + recovered_amount
```

If the **original payment** succeeds first, trusted `payment.captured` moves the financial case to `STOPPED` so Recovery OS does not count a second payment as recovered revenue.

PostgreSQL is the system of record for events, webhook deliveries, recovery cases/jobs, diagnoses, versioned plans, interventions, actions, scheduled work, contacts, conversations, payment promises, human escalations, Payment Link history, and audit history.

---

## Recovery integrity

Recovery OS deliberately separates **execution success** from **money recovery**.

A recommendation, scheduled retry, message send, successful provider API call, or Payment Link creation does **not** increase recovered revenue. A confirmed recovery requires a trusted paid outcome linked back to the recovery case.

A trusted recovery therefore contains:

- `status = RECOVERED`
- `financial_status = RECOVERED`
- positive `recovered_amount`
- `recovered_at`
- Razorpay Payment Link identity
- `terminal_reason = trusted_payment_link_paid`

The provider reconciliation command independently reads Razorpay's current Test Mode Payment Link state and compares it with local recovery accounting. In the fresh validation run above, it reported **4/4 paid links reconciled, 1/1 unpaid link excluded, ₹1,156 provider-backed recovered amount, and 0 mismatches**.

---

## Why AI is useful here

A fixed mapping such as `insufficient_funds → message` or `bank_outage → retry_later` can handle a first decision, but real recovery changes over time. The correct next action may depend on previous outreach, retry budget, Promise-to-Pay state, prior outcomes, and customer replies.

Recovery OS gives those changing business signals to the planner while deterministic policy remains authoritative. In the validated 12-scenario contextual benchmark, static rules + the same policy gate scored **9/12**, while AI planning with business guardrails + the same policy gate scored **12/12 on two consecutive local runs**.

---

## Release validation

The release pass exercised:

- 7 ordered PostgreSQL migrations
- TypeScript/core tests
- Payment Link integrity tests
- one-active-link database invariant
- older/superseded-link recovery after escalation
- financially stopped-case protection
- provider Payment Link lifecycle cancellation test
- signed webhook validation
- action idempotency
- retry/backoff/rate-limit handling
- retry exhaustion
- quiet hours
- human escalation
- conversational tool calling
- Promise-to-Pay flows
- trusted `payment_link.paid → RECOVERED`
- original `payment.captured → STOPPED`
- append-only audit guard
- live provider reconciliation

Useful validation commands:

```bash
npm run db:migrate
npm run typecheck
npm run test:payment-integrity
npm run test:payment-link-provider
npm run test:core
npm run evaluate:provider
```

For the detailed failure history and engineering trade-offs, see [`DEBUG.md`](./DEBUG.md) and [`DECISION.md`](./DECISION.md).

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js + TypeScript | Async webhook/provider I/O with explicit state contracts |
| HTTP | Express | Small and transparent API/webhook layer |
| Database | PostgreSQL | Transactions, joins, advisory locks, durable jobs, idempotency, and auditability |
| AI | Groq + `openai/gpt-oss-120b` | Structured diagnosis, planning, replanning, and conversation |
| Payments | Razorpay Test Mode | Payment Links and trusted paid-outcome webhooks |
| Email | Resend | Email delivery adapter |
| SMS / WhatsApp / Voice | Twilio | Shared messaging and voice adapters |
| Orchestration | Explicit services + durable workers | Inspectable and testable without hiding side effects in a graph framework |

No vector database or RAG layer is used because the core evidence is structured payment state and relational history, not semantic document retrieval.

---

## Local setup

```bash
git clone https://github.com/SHUBHANSHU602/Recovery-OS.git
cd Recovery-OS
npm install
cp .env.example .env
```

Start PostgreSQL, then run:

```bash
npm run db:migrate
npm run typecheck
npm run test:core
npm start
```

Configure integrations in `.env` when needed:

```env
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
GROQ_API_KEY=
RESEND_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
```

Other evaluation commands:

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
  execution/      ActionService + retry scheduler + provider lifecycle
  recovery/       recovery case/job workflow + Payment Link history
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

> **Let AI reason where the problem is ambiguous. Keep trust, safety, side effects, retries, idempotency, and recovered-money accounting deterministic.**
