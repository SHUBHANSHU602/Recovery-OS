# Recovery OS — Submission Evidence

This document separates **provider-backed integration proof**, **local benchmark evidence**, and **synthetic evaluation** so the submission does not overstate what was measured.

## Provider-backed financial integrity

`npm run evaluate:provider` performs a read-only reconciliation between the local Recovery OS ledger and the **current Razorpay Test Mode state** of every successfully created Payment Link in the validation dataset.

Validated result on the final local dataset:

| Check | Result |
|---|---:|
| Razorpay Payment Links checked | **10** |
| Provider-paid links | **1** |
| Provider-unpaid links | **9** |
| Paid links correctly reconciled | **1/1** |
| Unpaid links excluded from recovered revenue | **9/9** |
| Provider-backed recovered amount | **₹703.51** |
| Reconciliation mismatches | **0** |
| Final result | **PASS** |

The paid Razorpay Test Mode link was mapped to recovery case `43`, whose final state was `RECOVERED` with `₹703.51` recorded as recovered. The nine provider-unpaid links all remained at `₹0.00` recovered. Several of those cases had already reached `ESCALATED`, demonstrating that Payment Link creation, retry execution, or escalation alone does **not** count as recovered money.

**Submission claim:** Across 10 provider-created Razorpay Test Mode Payment Links, Recovery OS produced zero accounting mismatches: the 1/1 paid outcome was correctly recorded as ₹703.51 recovered, while all 9/9 unpaid links were excluded from recovered revenue.

This is **provider reconciliation and financial-integrity evidence**, not a causal revenue-lift experiment.

## Closed-loop recovery proof

A separate end-to-end validation exercised:

```text
signed payment.failed
→ durable recovery case/job
→ causal evidence
→ Groq diagnosis
→ deterministic verifier
→ AI recovery plan
→ deterministic policy
→ recovery action / conversation
→ trusted payment_link.paid
→ RECOVERED
→ recovered_amount recorded
```

The final closed-loop integration test passed. The release also verified that a trusted original `payment.captured` moves the case to `STOPPED` rather than counting it as Recovery OS recovered revenue.

## Decision-quality evidence

| Validation | Result |
|---|---:|
| Diagnosis accuracy on `batch_1` | **24/25 (96.0%)** |
| Durable recovery-case coverage | **25/25 (100%)** |
| Static rules + same deterministic policy gate | **9/12 (75.0%)** |
| AI planner + business guardrails + same policy gate | **12/12 (100.0%)** |
| AI benchmark repeat | **12/12 again** |

The 12-scenario comparison measures contextual decision quality under the same policy boundary. It is **not** presented as financial lift.

## Safety and reliability evidence

The release validation also passed tests for webhook signature verification, durable delivery processing, action idempotency, retry/backoff and provider rate-limit handling, retry exhaustion, quiet hours, contact caps, human escalation, conversational tool calling, Promise-to-Pay replacement and overdue replanning, trusted recovery accounting, original-payment terminal handling, and database-enforced append-only audit protection.

The append-only audit guard was directly tested: normal `UPDATE` and `DELETE` operations against `audit_log` were blocked by PostgreSQL.

## Synthetic evaluation boundary

The project also contains a seeded 500-case competitive benchmark. Its treatment/control probabilities are synthetic and it is retained only as evaluation plumbing and scenario coverage. Those results are **not** claimed as real merchant revenue lift or production performance.

## Reproduce the key checks

```bash
npm run test:core
npm run evaluate
npm run evaluate:ai
npm run evaluate:provider
```

`evaluate:provider` requires the local PostgreSQL validation dataset and Razorpay Test Mode credentials because it reads current Payment Link state directly from Razorpay.
