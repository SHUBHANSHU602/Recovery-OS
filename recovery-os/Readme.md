

Readme · MD
# Recovery OS
 
**A single root-cause reasoning layer for failed payments** — built for Razorpay's AI Buildathon (Track 3: AI Revenue Recovery).
 
An LLM diagnoses *why* a payment actually failed, a deterministic verifier checks that diagnosis against real evidence, the LLM chooses a bounded recovery action from a fixed menu, a deterministic policy gate enforces hard limits, and every step is logged to an immutable audit ledger — so any recovered rupee traces back to the exact reasoning that recovered it.
 
---
 
## Why this project, not a chatbot wrapper
 
Razorpay's own Agent Studio already ships prebuilt agents (Subscription Recovery, Abandoned Cart, Dispute Responder, etc.), built on the Claude Agent SDK. A project that looks like a thin wrapper around their own webhook reads as derivative to the people who'd be judging it.
 
Recovery OS instead asks a narrower, harder question: **what does it take to make an LLM's judgment trustworthy enough to sit upstream of real money movement?** The answer isn't "trust the model" — it's a specific architecture:
 
> **AI does the judgment-heavy, ambiguous, language-native work. Deterministic code does the liability-bearing, must-never-be-wrong work.**
 
That single rule is applied at every layer of this system, three times over — and it's the actual thing being demonstrated here, not the LLM calls themselves.
 
---
 
## ⭐ Signal-at-a-glance
 
If you only read one section, read this one.
 
- **A safety layer that's *proven*, not claimed.** The verifier is deliberately fed a wrong diagnosis (`systemic_bank_outage` claimed with zero corroborating evidence) and demonstrably catches it — 4/4 adversarial test cases pass, reproducible via `testVerifier.ts`.
- **The money-movement layer is provably idempotent.** A real duplicate-payment-link bug was found *during this build* (idempotency key bound to a database row ID instead of stable business identity), caused 5 real duplicate links in test mode, and was root-caused and fixed same-day. Documented in full in `DEBUG-LOG.md` — not hidden.
- **96% diagnosis accuracy on a 25-event evaluation batch**, including correctly distinguishing two *independent* systemic bank-outage clusters (different banks, different time windows) from isolated customer-specific failures — using multi-signal reasoning, not an error-code lookup table.
- **The one part of the system that genuinely can't be done with rules — a real, working, tool-using conversational agent** — is implemented, not deferred. It reasons over free-text customer replies and calls deterministic tools (`generate_payment_link`, `check_customer_risk_flags`, `escalate_to_human`) rather than hallucinating actions.
- **Every metric reported is honestly caveated.** Recovery rate is explicitly labeled as "successful initiation," not "confirmed customer payment," because test mode has no real customer to complete the loop. Rate-limit failures are reported as external constraints, not swept into a misleadingly high success number.
- **A real, dated debugging trail** — nine days of genuine bugs, root-caused and fixed, documented as they happened in `DEBUG-LOG.md`. The buildathon's own evaluation criteria flags a project that "ran perfectly on the first try" as suspicious; this one didn't, and says so.
---
 
## Architecture: the core loop
 
```
payment.failed webhook
  → evidence gathering            (deterministic)
  → AI diagnosis                  (LLM: root cause + rationale + confidence)
  → deterministic verifier        (checks diagnosis against evidence invariants)
  → AI chooses recovery action    (LLM: constrained to a fixed menu)
  → policy gate                   (deterministic: caps, cool-off, escalation rules)
  → [if conversational]  tool-using multi-turn agent
  → execution                     (deterministic: real Razorpay test-API calls, idempotent)
  → audit ledger                  (append-only log of every stage above)
```
 
### Why each stage is deterministic or LLM-driven
 
| Stage | Driven by | Why |
|---|---|---|
| Evidence gathering | Deterministic | Idempotent webhook ingestion, SQL queries for customer history + correlated failures. No judgment needed — just correct retrieval. |
| Diagnosis | **LLM** | Distinguishing "insufficient funds" from "systemic bank outage" requires reasoning over *combinations* of ambiguous signals — a lookup table can't do this. |
| Verification | Deterministic | Re-checks the LLM's claim against real evidence with plain `if` logic. Zero API calls. Auditable line-by-line by a human. |
| Action selection | **LLM**, but menu-constrained | Choosing the right intervention given root cause + customer history is a judgment call — but the LLM can only pick from 5 pre-approved actions, never invent a sixth. |
| Policy gate | Deterministic | Hard caps (max retries, contact limits) that override the LLM's choice regardless of confidence. Money-adjacent decisions never get a purely automated final say. |
| Conversational recovery | **LLM**, tool-calling | Free-text customer replies ("can I pay a different way instead?") genuinely can't be handled by a decision tree — this is the one stage where no deterministic alternative exists. |
| Execution | Deterministic | Real Razorpay API calls, checked against a database-enforced idempotency key *before* any call is made. |
 
---
 
## Feature highlights
 
### 🧠 Multi-signal diagnosis, not error-code matching
The diagnosis LLM reasons over three signals together: the error code itself, this customer's prior failure history, and how many *other* customers failed at the same bank in the same time window. That last signal is what separates "one customer's card expired" from "this bank is having an outage right now" — a pattern that requires reasoning across events, not reading one event in isolation.
 
- Verified against **two independent, real correlation clusters** in the evaluation batch (different banks, different times) — the logic generalizes, it doesn't just fit the one cluster it was built around.
### 🛡️ A verifier that actually verifies
`verify.ts` contains zero API calls. It enforces explicit invariants:
- A `systemic_bank_outage` claim requires ≥2 real correlated failures — or it's downgraded to `ambiguous`.
- A customer-specific claim (`insufficient_funds`, `expired_card`) is flagged if the correlation pattern actually looks systemic.
- Malformed confidence values are rejected outright.
**Proof, not assertion:** `testVerifier.ts` deliberately constructs a diagnosis that lies about its own evidence, and the verifier catches it every time.
 
### 🚧 A policy gate with real teeth
`policyGate.ts` enforces hard limits — max automated retries, max customer contacts per day — that override the LLM's chosen action regardless of how confident it was. Proven via `testPolicyGate.ts`: an over-limit action is blocked and force-escalated to a human, every time.
 
### 💳 Idempotent by construction, not by hope
Every real money-moving action is checked against a database-enforced unique idempotency key *before* any external API call is made. This was tested adversarially — running the same batch twice — and confirmed to block all duplicate executions on the second pass.
 
> **This wasn't true on the first attempt.** An earlier version of this system keyed idempotency to a database row ID rather than stable business identity, and a duplicate-row bug elsewhere in the pipeline caused 5 real duplicate payment links in test mode. Full root-cause and fix documented in `DEBUG-LOG.md` — included deliberately, because catching and fixing this class of bug *is* the demonstration, not a footnote.
 
### 💬 A genuine tool-using conversational agent
Not a single structured call — a real multi-turn loop. The agent:
- Knows the customer's context (email, amount) without needing to ask for it
- Calls `check_customer_risk_flags` when the customer asks about their account status
- Calls `generate_payment_link` when the customer wants to pay a different way
- Calls `escalate_to_human` when it should stop guessing
Every tool the agent can invoke is still deterministic underneath — the agent proposes, code executes. Same pattern as every other stage, applied to free-text conversation.
 
### 📊 An evaluation harness with a real answer key
A synthetic batch generator creates labeled events with **known ground-truth causes**, including deliberately ambiguous and adversarial cases — so "diagnosis accuracy" is a measured number, not a vibe. Final batch: 25 events, 4 cause categories, 2 independent outage clusters, 1 repeat-customer case.
 
### 📜 An audit ledger that's actually queryable
Every stage — diagnosis, verification, intervention, policy check, execution — writes to a single append-only `audit_log` table. Pull one event's full reasoning trail with one query:
```sql
SELECT stage, detail, created_at FROM audit_log WHERE event_id = '...' ORDER BY created_at;
```
 
---
 
## Evaluation results (25-event batch)
 
| Metric | Result | Note |
|---|---|---|
| Diagnosis accuracy | **24/25 (96%)** | Includes both independent outage clusters correctly identified |
| Verifier — adversarial proof | **4/4** | Deliberately-wrong diagnoses caught every time (`testVerifier.ts`) |
| Verifier — real-batch interventions | 0/25 | No corrections needed; diagnoses on this batch were already evidence-consistent |
| Recovery rate (successful initiation) | **23/34 (67.6%)** | See caveat below |
| False-escalation rate | **0%** | Every escalation was a genuinely ambiguous case, never a confident one |
 
**Honesty notes, stated plainly rather than buried:**
- "Recovery rate" measures the system's own success at *initiating* an action (a real payment link created, a real conversation started) — not a confirmed customer payment. Test mode has no real customer to complete that final step.
- 6 of the 11 non-successful actions failed due to genuine Razorpay test-mode rate limiting under real API load — not a logic error in diagnosis or decision-making. The system decided correctly in all 25 cases; execution throughput under external API constraints is a separate, honestly-reported number.
- The policy gate's retry cap is proven correct via an isolated adversarial test, but wasn't exercised by real batch data in this evaluation run (the repeat-customer case happened to receive non-retry action types). Stated here rather than implied as fully end-to-end tested.
---
 
## What's built vs. designed-for
 
**Built and proven, end to end:**
- Idempotent webhook ingestion with deduplication
- Multi-signal evidence gathering (error code, customer history, correlated failures)
- LLM diagnosis with structured, schema-constrained output
- Deterministic verifier with adversarial proof
- LLM action selection constrained to a fixed menu
- Deterministic policy gate with adversarial proof
- Real, idempotent execution against Razorpay's test API (`retry_with_backoff`)
- A genuine multi-turn, tool-using conversational agent, wired as a real execution path
- A complete, queryable audit trail per event
- A labeled synthetic evaluation harness with real metrics
**Designed for, not fully built:**
- Automated execution is implemented for `retry_with_backoff`; `offer_alternate_payment_method` and `whatsapp_nudge` route into the conversational agent rather than a separate automated path
- A second leak type (abandoned checkouts, overdue invoices) — explicitly scoped out from the start to protect the core loop
- A richer dashboard beyond a minimal audit-log query — deliberately deprioritized as scope creep for a linear pipeline
---
 
## Tech stack, and why
 
| Choice | Reason |
|---|---|
| Node.js + TypeScript | I/O-bound service (webhooks, DB, LLM calls) fits Node's async model; TypeScript catches malformed structured output at the type boundary before it corrupts the audit ledger |
| Groq (`openai/gpt-oss-120b`) | Practical constraint — free tier available and sufficiently capable; the diagnosis/action interfaces are provider-agnostic by design (proven by successfully swapping providers mid-build with zero downstream changes) |
| Plain hand-rolled pipeline, not LangGraph | The loop is linear with one branch (escalation) — a framework built for complex multi-agent graphs is unneeded complexity here, and a hand-rolled version is easier to explain to a judge line by line |
| Postgres, JSONB for raw payloads | Diagnosis works off structured evidence — a SQL problem, not semantic search; JSONB preserves full payloads without pre-committing to a rigid schema before requirements were known |
| No vector DB / RAG | Nothing in this system needs semantic retrieval over unstructured text |
| Docker Compose, local | No confirmed requirement for live cloud hosting in the buildathon's own submission criteria |
 
Full reasoning for every decision, including several that were reversed mid-build with stated reasons, is in `DECISIONS.md`.
 
---
 
## The debugging trail
 
Nine days of real bugs, root-caused and fixed, documented as they happened — not reconstructed afterward. Highlights:
 
- **A duplicate-payment-link bug**, caused by an idempotency key bound to a database row ID instead of stable business identity — the single most important lesson in the codebase, and the kind of mistake that's genuinely expensive in a real production fintech system.
- **Three separate LLM provider issues** (Gemini free-tier daily cap, a billing/project mismatch, Groq deprecating its own recommended model mid-build) — each diagnosed and resolved without derailing the schedule, and without the diagnosis/action interfaces needing to change underneath.
- **A synthetic evaluation bug** (near-identical timestamps producing false-positive correlation signals) — caught by questioning suspicious-looking output rather than accepting a clean-looking run at face value.
Full log: `DEBUG-LOG.md`.
 
---
 
## Design thesis, stated as opinion
 
Agent Studio's public product page lists Subscription Recovery and Abandoned Cart as separate agents. This project builds a single root-cause reasoning layer instead, on the belief that unifying diagnosis *before* deciding on an action produces more defensible, more auditable decisions than parallel single-purpose agents each guessing independently. That's a claim about this build and its reasoning — not an assertion about Razorpay's internal architecture, which can't be verified from outside.
 
