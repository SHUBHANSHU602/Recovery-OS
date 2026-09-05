# Recovery OS — Debugging Record

This file keeps the important engineering failures that shaped the current system. Each entry explains **what broke, why it broke, and how it was fixed** in plain language.

## 1. Duplicate Razorpay Payment Links were created on reruns

- **What broke:** Re-running the same recovery flow created multiple Razorpay Payment Links for the same failed payment.
- **Why:** The idempotency key used an auto-increment database row ID. Every rerun created a new row, so every rerun also looked like a brand-new action.
- **Fix:** Idempotency was moved to stable business identity: failed event + action + logical attempt number. The action row is now claimed in PostgreSQL before the external Razorpay call.
- **Extra protection:** Upstream diagnosis/intervention reruns also skip work that already exists.
- **Result:** The same logical attempt cannot execute twice, while legitimate later retry attempts can still run.

## 2. Webhook deduplication could lose real work

- **What broke:** A webhook could be stored successfully, downstream processing could fail, and a Razorpay retry of the same event could then be discarded as a duplicate.
- **Why:** The first implementation treated “event received” and “event fully processed” as the same state.
- **Fix:** Added a durable `webhook_deliveries` inbox with `RECEIVED`, `PROCESSING`, `PROCESSED`, and `FAILED` states.
- **Result:** Failed or stale processing can be reclaimed safely instead of being lost.

## 3. A database transaction was not guaranteed to use one connection

- **What broke:** The first transaction code used `pool.query("BEGIN")`, several more `pool.query(...)` calls, then `pool.query("COMMIT")`.
- **Why:** A PostgreSQL connection pool may send those calls to different physical connections.
- **Fix:** Multi-statement transactions now use `pool.connect()`, run `BEGIN / COMMIT / ROLLBACK` on that one checked-out client, and release it in `finally`.
- **Result:** Webhook persistence and other transactional writes now have real transaction boundaries.

## 4. API success was incorrectly treated as recovered money

- **What broke:** Early evaluation logic could treat successful action execution or Payment Link creation as recovery.
- **Why:** Execution success and business outcome were mixed together.
- **Fix:** Added durable `recovery_cases`. Only a trusted `payment_link.paid` outcome can move a case to `RECOVERED` and increase `recovered_amount`.
- **Result:** Creating a link, sending a message, or scheduling a retry cannot inflate recovered revenue.

## 5. Diagnosis could use information from the future

- **What broke:** Same-bank correlation and customer-history queries originally allowed later failures to influence an earlier diagnosis.
- **Why:** Evidence queries were not cut off at the failed payment’s event time.
- **Fix:** Every evidence query now stops strictly before the event timestamp, and the evidence cutoff is stored.
- **Result:** Recovery decisions use only information that was actually knowable at decision time.

## 6. Retry idempotency became too strict

- **What broke:** After fixing duplicate actions, a legitimate second `retry_with_backoff` could be blocked as a duplicate.
- **Why:** The idempotency key represented only “event + action,” not a specific retry attempt.
- **Fix:** Retry identity now includes the logical attempt number, for example `..._attempt_1`, `..._attempt_2`, `..._attempt_3`.
- **Result:** Each attempt is independently idempotent while the bounded retry sequence still works.

## 7. `retry_with_backoff` originally retried immediately

- **What broke:** The action name said “backoff,” but execution still happened immediately.
- **Why:** The first version had no durable scheduler.
- **Fix:** Added `scheduled_actions` with `run_at` timestamps and a worker that claims due work.
- **Retry behavior:** Honor `Retry-After` when present; otherwise use bounded exponential backoff with deterministic jitter for retryable 429/5xx/network failures.
- **Result:** Retries survive process restarts and stop after the configured automated-attempt limit.

## 8. Scheduler retries reused the same attempt number

- **What broke:** A second transient failure tried to schedule “attempt 2” again and collided with the unique key.
- **Why:** Attempt numbering was calculated from the current row instead of the full recovery case history.
- **Fix:** The next attempt number is derived from all scheduled attempts for that recovery case.
- **Result:** Retry identities advance correctly across separate scheduler rows.

## 9. Crash recovery could accidentally repeat an external side effect

- **What broke:** If a worker crashed after claiming an action but around the Razorpay call, the system could not always know whether that exact external side effect happened.
- **Why:** There is no guaranteed exactly-once boundary spanning PostgreSQL and an external provider call.
- **Fix:** If the exact claimed attempt is found in an ambiguous state after recovery, the system does **not** blindly repeat it. It fails closed and creates a human escalation.
- **Result:** Safety is preferred over accidentally creating a duplicate money-adjacent action.

## 10. Recovery continued after the original payment succeeded

- **What broke:** The system could continue recovery even after the original Razorpay payment became captured.
- **Why:** `payment.captured` was not treated as a terminal business signal.
- **Fix:** Trusted original-payment capture moves the case to `STOPPED` with `original_payment_captured`, cancels pending work, and does not count the money as Recovery OS recovered revenue.
- **Result:** Customers are not asked to pay twice.

## 11. Contact limits were vulnerable to concurrent sends

- **What broke:** Two channel requests could both check the 24-hour contact count at the same time and both send.
- **Why:** The flow was “check, send, then record,” which is race-prone.
- **Fix:** Recovery OS now obtains a per-customer PostgreSQL advisory transaction lock, rechecks the count, and creates a pending contact reservation before provider execution.
- **Result:** Concurrent requests cannot both consume the same contact slot.

## 12. Manual channel sends could bypass quiet hours

- **What broke:** Automated recovery respected quiet hours, but a manual channel action did not.
- **Why:** The manual path did not reuse the same contact-window rule.
- **Fix:** Manual channel execution now checks quiet hours before sending and fails closed until the next allowed time.
- **Result:** Automated and operator-triggered outreach follow the same policy boundary.

## 13. Replacing a Promise-to-Pay left the old reminder active

- **What broke:** Replacing a customer’s payment promise cancelled the old promise row but left its scheduled reminder pending.
- **Why:** Promise replacement and reminder cancellation were handled separately.
- **Fix:** Replacement now cancels the old pending promise and its pending reminder in the same transaction before creating the new promise/reminder.
- **Result:** Only the newest customer commitment can trigger future reminder work.

## 14. The AI planner underperformed a simple rules baseline

- **What broke:** On the 12-scenario contextual decision benchmark, static rules scored `9/12`, while the AI planner initially scored between `6/12` and `7/12` and changed answers between runs.
- **Why:** Important business invariants were only implied in the prompt, and the model call was not deterministic.
- **Fix:** Set planner temperature to `0`, strengthened the planning instructions, and added deterministic business guardrails based on real context: retry count, contact count, diagnosis confidence, prior action, Promise-to-Pay state, and historical strategy outcomes.
- **Important:** The guardrails do not inspect benchmark scenario IDs.
- **Result:** Two consecutive local runs scored `12/12` for AI planner + guardrails versus `9/12` for static rules + the same policy gate. Full core regression tests also passed.

## 15. Conversational recovery initially used stale or missing context

- **What broke:** The agent asked customers for information the backend already knew, and later code fixes appeared not to work in old conversations.
- **Why:** Trusted amount/customer data was not included in the model context, and existing conversation rows kept their old system context.
- **Fix:** The agent receives trusted recovery context from the backend and refreshes the live recovery context on every inbound turn.
- **Result:** The model reasons over the current verified diagnosis, plan, retry/contact state, and Promise-to-Pay without redefining trusted identity or amount.

## 16. Conversational Payment Links could be created but fail local persistence

- **What broke:** Razorpay successfully created a Payment Link, then the local action insert failed because `actions.intervention_id` was still `NOT NULL`.
- **Why:** Conversational actions do not always belong to an automated intervention row.
- **Fix:** Made `intervention_id` nullable and verified the migration actually applied.
- **Result:** Automated and conversational actions can share the same action ledger safely.

## 17. A successful Payment Link could be missing from channel messages

- **What broke:** Default recovery messages sometimes omitted a valid Razorpay Payment Link.
- **Why:** The channel query looked for action status `SUCCESS`, but the action service stores `success` in lowercase.
- **Fix:** Query `status = 'success'` and require `razorpay_api_call = 'payment_links.create'`.
- **Result:** Only a trusted successful Payment Link action can supply the URL used in recovery messaging.

## 18. A merge silently removed channel tests from the aggregate suite

- **What broke:** CI stayed green even though `test:channels` had disappeared from `test:core` after a merge.
- **Why:** The aggregate command still succeeded, so the missing test group was easy to miss.
- **Fix:** Restored `test:channels` and kept all intended test groups in `test:core`.
- **Result:** Green CI now represents the complete intended core suite.

## 19. The audit trail was append-only only by convention

- **What broke:** Application code only inserted audit rows, but PostgreSQL still allowed normal `UPDATE` and `DELETE` statements.
- **Why:** There was no database-level protection.
- **Fix:** Added a PostgreSQL trigger that rejects updates and deletes on `audit_log`.
- **Result:** The project can accurately describe the audit trail as **database-enforced append-only**.

## 20. Final E2E test was polluted by earlier test data

- **What broke:** A synthetic insufficient-funds E2E case was downgraded to `ambiguous` and escalated.
- **Why:** The test reused `HDFC`, while many earlier HDFC failures still existed inside the 30-minute correlation window. The verifier correctly interpreted that as possible systemic behavior.
- **Fix:** The final E2E fixture now uses a unique synthetic bank name per run.
- **Result:** Test history cannot accidentally change the intended diagnosis, while the production correlation rule stays strict.

## 21. Final E2E verification queried the wrong audit column

- **What broke:** The product reached `RECOVERED`, then the test script failed while reading `audit_log.payload`.
- **Why:** The real column is named `detail`.
- **Fix:** Corrected the test query to `audit_log.detail`.
- **Result:** The final closed-loop E2E completed successfully: signed failure webhook → diagnosis → verifier → plan → policy → recovery action → conversation → signed paid outcome → `RECOVERED` → dashboard `RECOVERED`.

## 22. Synthetic batch timestamps created false bank correlation

- **What broke:** Early synthetic events were inserted too close together, so unrelated failures looked correlated.
- **Why:** Test timestamps did not model isolated and clustered failures separately.
- **Fix:** Added explicit timestamp offsets so only intended outage clusters fall inside the 30-minute window.
- **Result:** The benchmark now tests contextual evidence instead of accidental timestamp collisions.

## 23. Batch reruns accumulated stale diagnoses and interventions

- **What broke:** Repeated troubleshooting created multiple diagnosis rows for the same event and later produced repeated intervention work.
- **Why:** The batch flow did not clean or skip previously processed rows consistently.
- **Fix:** Added rerun guards and deterministic batch cleanup where appropriate.
- **Result:** Re-running evaluation does not multiply the same business work.

## 24. Importing diagnosis code caused an extra model call

- **What broke:** Importing `diagnose()` also ran the file’s CLI `main()` function.
- **Why:** The executable entry point was not guarded.
- **Fix:** Added a `require.main === module` check.
- **Result:** Importing reusable functions no longer produces hidden API calls.

## 25. Smaller environment and tooling issues

- Installed `@types/pg` without the runtime `pg` package → installed `pg`.
- Left a placeholder PostgreSQL password in early code → moved credentials to `.env`.
- Used an unsupported international Razorpay test card → switched to the documented Indian test scenario card.
- Windows console could not display a stored rupee symbol correctly → adjusted client encoding for inspection; data itself was not corrupted.
- `replaceAll` was outside the repository TypeScript target → replaced with compatible `split(...).join(...)` logic.
- A test fixture left a pending recovery job that a later smoke test could consume → marked the synthetic job complete during cleanup.

---

The debugging record is intentionally kept because Recovery OS deals with payment-adjacent side effects. The strongest guarantees in the final design—idempotency, trusted outcomes, retry safety, causal evidence, deterministic policy, and durable state—came directly from failures found during testing.