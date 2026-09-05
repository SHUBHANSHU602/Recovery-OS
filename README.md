# Recovery OS

**Closed-loop AI revenue recovery for failed payments.**

Recovery OS turns a failed payment into a durable recovery workflow instead of treating it as a blind retry problem. It verifies the payment event, gathers causal evidence, diagnoses the likely reason, creates a contextual recovery plan, applies deterministic safety controls, executes recovery work, follows up with the customer, and records recovered money only after a trusted provider payment outcome.

> **AI handles ambiguity, planning, and customer language. Deterministic systems handle trust, policy, side effects, idempotency, retries, and money accounting.**

---

## The problem

Payment failures are usually handled with generic retries, disconnected support flows, or simple rule tables. That breaks down when the right next action depends on context: a bank outage should not be treated like insufficient funds, an expired card needs another payment method, repeated outreach must respect contact limits, an unresolved Promise-to-Pay may require replanning, and a successfully created Payment Link is not the same as recovered revenue.

Recovery OS keeps one durable recovery case per failed payment and moves that case through evidence, diagnosis, planning, execution, follow-up, escalation, and trusted outcome handling.

---

## Razorpay Test Mode provider proof

A fresh provider-validation run was executed against a separate Razorpay Test Mode merchant environment after the Payment Link integrity hardening work.

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

The five Payment Links were created through Recovery OS using Razorpay Test Mode. Four were intentionally paid through Razorpay-hosted Test Mode checkout. All four became trusted `RECOVERED` cases with matching provider state and recovered amount. The fifth link was intentionally left unpaid; it remained financially open with `₹0` recovered and was not falsely attributed as revenue.

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

<img width="620" height="350" alt="provider reconciliation PASS" src="https://github.com/user-attachments/assets/d4102026-cb69-4bf8-b341-f2fbe3439e93" />

This is a **controlled Test Mode integration validation**, not a production recovery-rate claim. The valid statement is that **4/4 intentionally paid test links were reconciled correctly**, while the unpaid control was not counted as recovered revenue.

An earlier independent Razorpay Test Mode environment also reconciled **10/10 links with 0 mismatches**, including one paid link worth **₹703.51** and nine unpaid links correctly excluded from recovered revenue.

---

## Core features

| Capability | What Recovery OS does |
|---|---|
| **Trusted webhook ingestion** | Verifies Razorpay webhook signatures from the raw request body, persists delivery state, and safely reclaims failed/stale processing. |
| **Durable recovery cases** | Tracks amount at risk, financial state, automation state, strategy, terminal reason, confirmed recovered amount, and restartable recovery jobs. |
| **Payment Link history** | Stores every recovery Payment Link with lifecycle state instead of relying on one current-link field. |
| **Duplicate-payment protection** | Enforces at most one locally `ACTIVE` recovery link per case, reuses provider-active links, and cancels outstanding provider links after trusted financial closure. |
| **Financial vs automation state** | Keeps `financial_status` separate from `automation_status`, so escalation or automation stop does not erase the ability to recognize a later trusted payment. |
| **Causal evidence engine** | Uses provider error data, customer history, same-bank correlation, amount at risk, and prior outcomes without allowing future events to leak into earlier decisions. |
| **AI diagnosis + deterministic verifier** | Groq produces structured diagnosis; deterministic code checks whether the evidence actually supports it. |
| **Contextual AI planning and replanning** | Builds versioned recovery plans from diagnosis, retry/contact state, prior outcomes, previous plans, customer replies, Promise-to-Pay state, and strategy evidence. |
| **Deterministic policy gate** | Enforces recovery-link attempt caps, contact caps, quiet hours, opt-out, ambiguity handling, and human-escalation conditions. |
| **ActionService + idempotency** | Reloads trusted payment data, rechecks policy, claims logical attempts, reuses active links, fails closed on ambiguous provider state, and records provider results. |
| **Durable delayed recovery** | `issue_recovery_payment_link_after_backoff` schedules the customer-authorized recovery-link flow for later; it does not recharge the original payment. |
| **Conversational recovery agent** | Uses live case state and can create a recovery Payment Link, inspect risk state, record Promise-to-Pay, or escalate. |
| **Promise-to-Pay** | Persists commitment, due time, reminder work, replacement/cancellation logic, and fulfillment after trusted payment. |
| **Omnichannel recovery** | Automated recovery routes through the shared Resend/Twilio channel layer when credentials are configured, storing provider message IDs and delivery status; otherwise simulation is explicit. |
| **Durable human escalation** | Creates operator work items when automation is blocked, exhausted, ambiguous, or unsafe to replay. |
| **Trusted recovery accounting** | A recovery Payment Link paid outcome can close a financially-open case even after escalation; original `payment.captured` instead closes the case as `STOPPED`. |
| **Append-only audit trail** | Important decisions are written to `audit_log`; a PostgreSQL trigger blocks normal `UPDATE` and `DELETE`. |
| **Live merchant console** | Separates recovery effectiveness from execution reliability, shows financial/automation state, strategy effectiveness, Payment Link lifecycle, stop/escalation reason, channels, and audit activity. |

### Accurate payment action names

Recovery OS no longer describes Payment Link issuance as retrying the original charge. New AI/planner and user-facing actions are:

```text
issue_recovery_payment_link
issue_recovery_payment_link_after_backoff
offer_alternate_payment_method
whatsapp_nudge
escalate_to_human
```

The first two actions create/reuse a Razorpay Payment Link that requires fresh customer authorization. Legacy `retry_now` / `retry_with_backoff` values remain accepted only for backward compatibility with already-persisted rows and older tests.

---

## Dashboard evidence model

The merchant console deliberately separates two categories that should never be mixed:

### Recovery effectiveness

- trusted recovered amount
- recovered cases
- financially open cases
- financially stopped cases
- strategy-level cases attempted
- strategy-level recovered cases
- strategy recovery rate
- strategy recovered revenue
- average attempts

### Execution reliability

- successful actions
- customers contacted
- Payment Links created
- currently active Payment Links
- provider/channel delivery state

A successful API call can increase an execution metric, but it **cannot** increase recovered revenue.

Each case also exposes:

- **Financial state:** `OPEN / RECOVERED / STOPPED`
- **Automation state:** `ACTIVE / WAITING / SCHEDULED / ESCALATED / EXHAUSTED / STOPPED`
- why automation stopped or escalated
- complete Payment Link lifecycle history: link ID, local lifecycle, provider status, amount, amount paid, creation time, and current-active marker

---

## Fair AI-vs-deterministic benchmark

The earlier comparison of simple static rules against AI + extra deterministic business guardrails was not a fair way to attribute improvement to AI. That comparison is no longer used as evidence.

The benchmark now compares:

```text
Context-aware deterministic planner
+ the same contextual business guardrails
+ the same deterministic policy gate

VS

AI contextual planner
+ the same contextual business guardrails
+ the same deterministic policy gate
```

The only intended difference is **who proposes the seed plan**: deterministic logic or the LLM. Both arms receive the same safety and business constraints. The deterministic arm is covered by the core test suite; run the live AI arm with:

```bash
npm run evaluate:ai
```

Do not interpret this benchmark as revenue lift. It measures labeled contextual decision quality only.

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
financial state + automation state
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
Shared contextual guardrails
        │
        ▼
Deterministic policy gate
        │
        ▼
ActionService
idempotency + provider-safe execution
        │
        ├── issue/reuse recovery Payment Link
        ├── delayed recovery-link scheduling
        ├── Twilio / Resend outreach
        ├── conversation / Promise-to-Pay
        └── human escalation
        │
        ▼
trusted provider outcome
        │
        ├── recovery Payment Link paid → RECOVERED
        └── original payment captured → STOPPED
```

PostgreSQL is the system of record for events, webhook deliveries, recovery cases/jobs, diagnoses, plans, interventions, actions, scheduled work, contacts, channel deliveries, conversations, promises, human escalations, Payment Link history, and audit history.

---

## Recovery integrity

Recovery OS separates **execution success** from **financial success**.

A recommendation, message, API success, scheduled task, or Payment Link creation does **not** increase recovered revenue. A confirmed recovery requires:

- `status = RECOVERED`
- `financial_status = RECOVERED`
- positive `recovered_amount`
- `recovered_at`
- a recovery Payment Link identity
- `terminal_reason = trusted_payment_link_paid`

Human escalation only stops automation. If an older trusted Payment Link is paid later while `financial_status = OPEN`, the case can still become `RECOVERED`.

If the **original payment** succeeds first, trusted `payment.captured` sets `financial_status = STOPPED`, cancels pending recovery work, and does not attribute that money to Recovery OS.

---

## Provider-backed effectiveness reporting

`npm run evaluate:provider` now reports both provider reconciliation and the portfolio metrics needed for a larger controlled batch:

- failed-payment cases represented
- revenue at risk
- cases recovered
- unresolved financial cases
- escalated automation cases
- financially stopped cases
- observed controlled-dataset recovery percentage
- average recovery Payment Links per case
- cases with more than one locally active recovery link
- recovery by strategy
- false provider/local recovery mismatches

The repository does **not** claim a 30-case provider-backed result until such a batch is actually executed. The validated provider result currently remains the fresh 5-link run above.

---

## Release validation

The core release validation covers:

- seven PostgreSQL migrations
- TypeScript typecheck
- trusted webhook ingestion
- Payment Link history and one-active-link invariant
- older/superseded Payment Link recovery after escalation
- financially stopped-case protection
- provider Payment Link cancellation lifecycle
- action idempotency
- bounded backoff / rate-limit handling
- quiet hours and contact caps
- human escalation
- conversational tool calling
- Promise-to-Pay flows
- original `payment.captured → STOPPED`
- recovery `payment_link.paid → RECOVERED`
- database-enforced append-only audit trail
- fair deterministic benchmark arm
- dashboard/API smoke tests

Useful commands:

```bash
npm run db:migrate
npm run typecheck
npm run test:payment-integrity
npm run test:payment-link-provider
npm run test:core
npm run evaluate:ai
npm run evaluate:provider
```

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js + TypeScript | Async webhook/provider I/O with explicit state contracts |
| HTTP | Express | Transparent API and webhook layer |
| Database | PostgreSQL | Transactions, advisory locks, durable jobs, idempotency, history, and auditability |
| AI | Groq + `openai/gpt-oss-120b` | Structured diagnosis, planning, replanning, and conversation |
| Payments | Razorpay Test Mode | Payment Links and trusted paid-outcome webhooks |
| Email | Resend | Live email adapter when configured |
| SMS / WhatsApp / Voice | Twilio | Live messaging/voice adapters when configured |
| Orchestration | Explicit services + durable workers | Inspectable side effects and restartable workflows |

No vector database or RAG layer is used because the core evidence is structured payment state and relational history, not semantic documents.

---

## Local setup

```bash
git clone https://github.com/SHUBHANSHU602/Recovery-OS.git
cd Recovery-OS
npm install
cp .env.example .env
npm run db:migrate
npm run typecheck
npm run test:core
npm start
```

Configure provider credentials in `.env` when needed:

```env
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
GROQ_API_KEY=
RESEND_API_KEY=
RECOVERY_EMAIL_FROM=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_SMS_FROM=
TWILIO_WHATSAPP_FROM=
TWILIO_VOICE_FROM=
```

---

## Repository map

```text
src/
  ingestion/      webhook trust boundary + server
  evidence/       causal evidence collection
  diagnosis/      structured AI diagnosis
  verifier/       deterministic evidence checks
  policy/         bounded actions + hard policy limits
  execution/      ActionService + scheduler + provider lifecycle
  recovery/       case workflow + financial state + Payment Link history
  agent/          contextual planner + conversation tools
  intelligence/   prioritization, quiet hours, Promise-to-Pay
  channels/       Resend/Twilio adapters + delivery ledger
  dashboard/      merchant console APIs and metrics
  evaluation/     decision benchmark + provider reconciliation/reporting
  ledger/         audit logging
  db/             migrations/runtime schema support

sql/              ordered PostgreSQL migrations
DEBUG.md          important bugs, root causes, fixes, and validation results
DECISION.md       architecture choices and trade-offs
SUBMISSION_EVIDENCE.md submission-facing validation summary
```

---

## Engineering principle

> **Let AI reason where the problem is ambiguous. Keep trust, safety, side effects, idempotency, retries, and recovered-money accounting deterministic.**
