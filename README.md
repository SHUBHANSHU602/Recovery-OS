# Recovery OS

**Closed-loop AI revenue recovery for failed payments.**

Recovery OS is a payment-recovery system built around one simple idea:

> **AI should reason about recovery strategy and customer intent. Deterministic systems should control trust, policy, side effects, retries, and money accounting.**

A failed payment is not just logged. Recovery OS turns it into a durable recovery case, gathers causal evidence, diagnoses the likely cause, plans the next recovery action, executes safely, follows up when needed, talks to the customer, and stops only when the payment outcome is known.

---

## The problem

Merchants lose revenue when failed payments are handled with generic retries or disconnected support workflows.

Typical problems include:

- every failure being treated the same way,
- retrying too aggressively during bank or provider outages,
- sending customers repeated recovery messages,
- losing retry state when a worker restarts,
- creating duplicate payment actions during retries or reruns,
- continuing recovery after the original payment has already succeeded,
- treating Payment Link creation as if money had already been recovered,
- using AI recommendations without deterministic safety checks,
- customer conversations that are disconnected from the actual recovery state.

Recovery OS turns those failure states into a **durable, explainable recovery workflow**.

---

## What Recovery OS does

### 1. Trusted failed-payment ingestion

- Receives Razorpay payment webhooks.
- Verifies webhook authenticity from the raw request body using HMAC-SHA256.
- Stores webhook delivery state separately from business processing state.
- Reclaims failed or stale webhook work safely instead of discarding retries as duplicates.

### 2. Durable recovery cases

- Creates one `recovery_case` for each original failed payment.
- Tracks amount at risk, current strategy, recovery status, provider Payment Link, terminal reason, and confirmed recovered amount.
- Creates durable recovery jobs so the workflow survives server restarts.

### 3. Causal evidence gathering

For every failed payment, Recovery OS builds a decision-time evidence snapshot from data that existed **before** that event:

- provider error code,
- provider error description,
- customer failure history,
- same-bank failure correlation,
- amount at risk,
- prior recovery outcomes.

Future failures are never allowed to leak into an earlier diagnosis.

### 4. AI-powered diagnosis

The model produces a structured diagnosis from a bounded cause set:

- `insufficient_funds`
- `expired_card`
- `systemic_bank_outage`
- `ambiguous`

A deterministic verifier checks whether that diagnosis is consistent with the evidence before recovery proceeds.

### 5. Contextual AI recovery planning

Instead of mapping one failure reason directly to one action, Recovery OS creates a structured recovery plan using:

- verified diagnosis,
- amount at risk,
- retry count,
- recent customer contacts,
- prior customer outcomes,
- historical strategy outcomes,
- previous recovery plan,
- new business observations such as a customer reply or overdue Promise-to-Pay.

The planner can choose only from an approved action set:

- `retry_now`
- `retry_with_backoff`
- `offer_alternate_payment_method`
- `whatsapp_nudge`
- `escalate_to_human`

Each plan is versioned and stores:

- objective,
- primary action,
- fallback action,
- reasoning,
- escalation criteria,
- stop conditions.

### 6. Deterministic policy and business guardrails

AI does not have final authority.

Recovery OS applies deterministic checks for:

- automated retry limits,
- customer contact limits,
- quiet hours,
- terminal recovery states,
- low-confidence or ambiguous cases,
- Promise-to-Pay rules,
- repeated failed strategies,
- human escalation conditions.

This means the model can reason, but it cannot bypass hard recovery rules.

### 7. Centralized ActionService

All payment-adjacent side effects go through one execution boundary.

The ActionService:

- reloads trusted customer and payment data,
- re-applies deterministic policy immediately before execution,
- claims an idempotent action record before external provider calls,
- records provider success or failure durably,
- prevents duplicate execution of the same logical action attempt.

The conversational agent uses the same ActionService as the automated recovery path.

### 8. Durable retry and backoff engine

`retry_with_backoff` is real scheduled work, not an in-memory sleep.

Recovery OS:

- stores future work in `scheduled_actions`,
- atomically claims due jobs,
- honors `Retry-After` when available,
- otherwise uses bounded exponential backoff with deterministic jitter,
- retries transient 429/5xx/network-style failures,
- uses logical attempt IDs for idempotency,
- stops after the automated retry limit,
- escalates safely when retries are exhausted or execution state is uncertain.

### 9. Conversational recovery agent

Recovery OS includes a tool-using conversational agent that works from the **same live recovery state** as the automated planner.

On each customer turn it receives the latest:

- verified diagnosis,
- recovery plan,
- retry state,
- recent contact state,
- Promise-to-Pay state,
- trusted amount and customer identity.

Available tools include:

- generate a Payment Link through the ActionService,
- check customer risk flags,
- record an explicit Promise-to-Pay,
- escalate to a human operator.

The model can interpret customer language, but it cannot redefine trusted payment data.

### 10. Promise-to-Pay workflow

If a customer explicitly commits to paying later, Recovery OS can persist that commitment.

A Promise-to-Pay stores:

- promised amount,
- due time,
- source,
- status,
- scheduled reminder work.

Only one pending promise is active per case. Replacing it cancels the old promise and its pending reminder. A trusted paid outcome fulfills the promise and cancels remaining scheduled work.

### 11. Omnichannel recovery

Recovery OS supports one shared channel layer for:

- email,
- SMS,
- WhatsApp,
- voice.

Provider adapters support:

- **Resend** for email,
- **Twilio** for SMS, WhatsApp, and voice.

All channels share the same safety boundary:

- terminal-state checks,
- quiet-hours checks,
- customer-wide 24-hour contact caps,
- trusted recovery data,
- durable delivery records.

When provider credentials are not configured, the same channel workflow can run in explicit simulation mode for local testing.

### 12. Durable human escalation

Escalation is stored as a real operator work item, not just a log message.

Recovery OS creates `human_escalations` when:

- policy blocks further automation,
- retries are exhausted,
- evidence is ambiguous,
- crash recovery is unsafe to replay,
- the AI or conversation flow intentionally hands off.

### 13. Trusted recovery accounting

Recovery OS separates **execution** from **recovery outcome**.

These do **not** mark a case as recovered:

- AI recommends an action,
- a retry is scheduled,
- a recovery message is sent,
- a Payment Link is created,
- a provider API request succeeds.

A case becomes `RECOVERED` only when a trusted `payment_link.paid` outcome is processed and linked to that recovery case.

If the original payment later succeeds, the case becomes `STOPPED` instead so the customer is not asked to pay again.

### 14. Database-enforced append-only audit trail

Important recovery stages are recorded in `audit_log`, including:

- trusted webhook ingestion,
- evidence snapshot,
- diagnosis,
- verification,
- AI plan,
- prioritization,
- policy decision,
- action execution,
- outcome review,
- escalation,
- trusted payment outcome.

A PostgreSQL trigger rejects normal `UPDATE` and `DELETE` operations on the audit table.

### 15. Live merchant console

Recovery OS includes a live merchant-facing console for understanding and operating the recovery loop.

The console shows:

- recent recovery activity,
- case state,
- versioned AI plans,
- diagnosis and policy results,
- scheduled work,
- action history,
- customer contact history,
- conversations,
- Promise-to-Pay state,
- human escalations,
- channel delivery activity.

The console auto-refreshes and includes guarded local testing controls for recovery actions.

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
                    │ raw body + HMAC verification     │
                    │ durable webhook delivery inbox   │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │       Recovery Case + Job        │
                    │ durable state in PostgreSQL      │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │        Evidence Engine           │
                    │ event-time-safe payment history  │
                    │ customer + same-bank signals     │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │        AI Diagnosis              │
                    │ Groq / gpt-oss-120b             │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │   Deterministic Verifier         │
                    │ evidence invariants              │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │     AI Recovery Planner          │
                    │ versioned plan + replanning      │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │ Policy + Business Guardrails     │
                    │ retries / contacts / safety      │
                    └───────────────┬──────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │          ActionService           │
                    │ idempotency + trusted execution  │
                    └───────┬─────────┬─────────┬──────┘
                            │         │         │
              ┌─────────────┘         │         └──────────────┐
              ▼                       ▼                        ▼
   ┌───────────────────┐   ┌────────────────────┐   ┌───────────────────┐
   │ Retry Scheduler   │   │ Conversation Agent │   │ Human Escalation  │
   │ durable backoff   │   │ tools + live state │   │ durable work item │
   └─────────┬─────────┘   └──────────┬─────────┘   └───────────────────┘
             │                        │
             └──────────────┬─────────┘
                            ▼
                ┌───────────────────────────┐
                │ Recovery Channels         │
                │ email / SMS / WhatsApp    │
                │ voice / Payment Link      │
                └────────────┬──────────────┘
                             │
                             ▼
                ┌───────────────────────────┐
                │ Trusted Payment Outcome   │
                │ payment_link.paid         │
                └────────────┬──────────────┘
                             │
                             ▼
                ┌───────────────────────────┐
                │ RECOVERED / STOPPED       │
                │ accounting + cancellation │
                └───────────────────────────┘
```

### Supporting system-wide layers

```text
PostgreSQL
├─ events
├─ webhook_deliveries
├─ recovery_cases
├─ recovery_jobs
├─ diagnoses
├─ recovery_plans
├─ interventions
├─ actions
├─ scheduled_actions
├─ outbound_contacts
├─ channel_deliveries
├─ conversations
├─ payment_promises
├─ human_escalations
└─ audit_log

Merchant Console
└─ reads the same durable state used by workers and APIs
```

---

## End-to-end recovery flow

```text
1. Razorpay sends payment.failed
        ↓
2. Signature is verified
        ↓
3. Webhook is persisted and claimed
        ↓
4. Recovery case + recovery job are created
        ↓
5. Decision-time evidence is gathered
        ↓
6. AI diagnoses the failure
        ↓
7. Deterministic verifier checks the diagnosis
        ↓
8. AI builds a versioned recovery plan
        ↓
9. Deterministic policy/guardrails approve or override
        ↓
10. ActionService executes or schedules the action safely
        ↓
11. Customer may receive outreach / enter conversation / make a Promise-to-Pay
        ↓
12. Unresolved business outcomes can trigger AI replanning
        ↓
13. Trusted payment_link.paid arrives
        ↓
14. Case becomes RECOVERED
        ↓
15. Recovered amount is persisted and pending recovery work is cancelled
```

If the **original payment** succeeds before Recovery OS recovers it, the case becomes `STOPPED` and pending recovery work is cancelled.

---

## Why AI is actually useful here

A simple rule such as:

```text
insufficient_funds → send message
expired_card → alternate payment method
bank outage → retry later
```

works only for the first decision.

Real recovery becomes contextual after that:

- Did the previous nudge fail?
- Has the retry budget been exhausted?
- Did the customer already receive a message today?
- Did they promise to pay later?
- Has that promise become overdue?
- Did historical retry outcomes perform better than messaging for similar cases?
- Did new bank evidence change the picture?

Recovery OS gives those changing business signals to the AI planner, then applies deterministic safety rules afterward.

In the local contextual benchmark:

```text
Static rules + same deterministic policy: 9/12
AI planner + business guardrails + same deterministic policy: 12/12
```

This benchmark measures **contextual decision quality**, not revenue lift.

---

## Validation highlights

The completed release-validation pass covered the major failure and safety paths:

- TypeScript typecheck and full core regression suite.
- Deterministic policy tests.
- Deterministic verifier tests.
- Dashboard integration tests.
- Recovery-intelligence and Promise-to-Pay tests.
- Omnichannel delivery and contact-cap tests.
- Competitive benchmark tests.
- Final AI planner tests.
- Signed invalid and valid webhook handling.
- Real Razorpay Test Mode Payment Link API execution path.
- Exact action idempotency.
- Retry scheduling, backoff, rate-limit handling, and retry exhaustion.
- Quiet-hours enforcement.
- Durable human escalation.
- Conversational AI tool calling.
- Promise-to-Pay creation, replacement, and overdue replanning.
- Trusted `payment_link.paid → RECOVERED` handling.
- Trusted original `payment.captured → STOPPED` handling.
- Database-enforced append-only audit protection.
- Final closed-loop E2E integration from signed failed-payment webhook to `RECOVERED` dashboard state.

The final closed-loop validation proved this system path:

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

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js | Async I/O-heavy webhook and provider workflow |
| Language | TypeScript | Strong contracts around payment and recovery state |
| HTTP | Express | Small, transparent API and webhook layer |
| Database | PostgreSQL | Transactions, joins, locks, durable queues, idempotency, auditability |
| AI | Groq + `openai/gpt-oss-120b` | Structured diagnosis, planning, replanning, conversation |
| Payments | Razorpay Test Mode | Payment Links and trusted payment outcomes |
| Email | Resend | Recovery email provider adapter |
| SMS / WhatsApp / Voice | Twilio | Shared messaging and voice provider integration |
| Orchestration | Explicit services + durable workers | Easy to audit and reason about |
| Local DB setup | Docker Compose or native PostgreSQL | Reproducible development environment |

---

## Local setup

### Requirements

- Node.js 20+
- PostgreSQL
- npm

### Clone and install

```bash
git clone https://github.com/SHUBHANSHU602/Recovery-OS.git
cd Recovery-OS
npm install
```

### Configure environment

```bash
cp .env.example .env
```

Core values:

```env
DATABASE_URL=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
GROQ_API_KEY=
```

Optional live channel providers:

```env
RESEND_API_KEY=
RECOVERY_EMAIL_FROM=

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_SMS_FROM=
TWILIO_WHATSAPP_FROM=
TWILIO_VOICE_FROM=
```

### Start PostgreSQL with Docker Compose

```bash
docker compose up -d
```

Or use a local PostgreSQL installation and point `DATABASE_URL` to it.

### Apply migrations

```bash
npm run db:migrate
```

### Run the full core test suite

```bash
npm run test:core
```

### Start Recovery OS

```bash
npm start
```

Then open the merchant console from the local server.

---

## Useful commands

```bash
npm run typecheck
npm run test:core
npm run test:policy
npm run test:verifier
npm run test:dashboard
npm run test:intelligence
npm run test:channels
npm run test:ai
npm run evaluate
npm run evaluate:competitive
npm run evaluate:ai
```

---

## Repository structure

```text
src/
├─ ingestion/      webhook trust boundary + server
├─ evidence/       causal payment evidence
├─ diagnosis/      structured AI diagnosis
├─ verifier/       deterministic evidence checks
├─ agent/          recovery planner + conversational agent
├─ policy/         deterministic policy limits
├─ execution/      ActionService + scheduled retry engine
├─ recovery/       recovery cases, jobs, replanning state
├─ intelligence/   prioritization + Promise-to-Pay
├─ channels/       email / SMS / WhatsApp / voice
├─ dashboard/      merchant console APIs and live runtime state
├─ evaluation/     model and system benchmarks
├─ ledger/         audit trail
└─ db/             migration runner

sql/               ordered PostgreSQL migrations
public/            merchant console + channel console
DEBUG.md           important bugs and how they were fixed
DECISION.md        engineering and architecture decisions
```

---

## Engineering records

- [`DEBUG.md`](./DEBUG.md) explains the most important failures found during development, why they happened, and how they were fixed.
- [`DECISION.md`](./DECISION.md) explains the architecture choices, trust boundaries, tech stack, and trade-offs behind the final system.

---

## Project principle

Recovery OS is not built around “let the AI do everything.”

It is built around a stricter boundary:

> **Use AI where the problem is ambiguous. Use deterministic systems where the result must be trusted.**
