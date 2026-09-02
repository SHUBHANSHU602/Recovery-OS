# Debug Log

## Day 1
1. **International test card rejected.** Used 4111 1111 1111 1111 (generic international Visa test number) — account only accepts domestic cards. Fix: used Razorpay's documented Indian-scenario test cards (4100 2800 0009 0000).
2. **ts-node MODULE_NOT_FOUND on valid path.** ts-node failed to resolve src/ingestion/server.ts on Windows + Node 24.11.0 — internal project-dir resolution bug. Tried tsx as an alternative, hit a separate ESM resolution error. Fix: deferred TypeScript to Day 4, wrote Day 1's webhook receiver in plain CommonJS JS to stay unblocked.
3. **Error code mismatch in webhook payload.** Test card selected for payment_timed_out scenario, but the actual webhook payload showed error_code: BAD_REQUEST_ERROR instead. Manual "Failure" click in test mode doesn't preserve the specific test-card error type. Noted for Day 3: synthetic batch generator will be the reliable source of varied error codes, not manual test-mode failures.

## Day 2
1. **`Cannot find module 'pg'`.** Installed @types/pg (type definitions only) but not the actual pg runtime package. Fix: npm install pg.
2. **`password authentication failed for user "postgres"`.** Left the literal placeholder "YOUR_POSTGRES_PASSWORD" in server.ts instead of the real password. Fix: replaced with actual value, then migrated to .env shortly after to avoid hardcoding credentials in source at all.
3. **No resend/replay option found in Razorpay's test-mode webhook dashboard.** Used curl with a duplicate x-razorpay-event-id header to replay a request directly against the local server instead — proved dedup without needing dashboard support for it.

## Day 3
1. **Correlated-failures signal was meaningless on first synthetic batch.** All 10 synthetic events were inserted back-to-back in one script run, giving them near-identical timestamps — so the 30-minute correlation window matched every event at the same bank regardless of intended cause, not just the deliberate systemic_bank_outage cluster. Non-outage events showed false-positive correlation counts (1-2) instead of 0. Fix: added explicit offsetMinutes per template so isolated events are hours/days apart and only the outage cluster falls within the same 30-min window. Re-ran and confirmed correlatedFailuresAtSameBank: 3 only on the outage cluster, 0 everywhere else.
2. **customerFailureCount untested** — no synthetic customer currently has more than one failure, so this signal hasn't been validated against real repeat-failure data yet. To be exercised in Day 4 once diagnosis runs against events with actual customer history, or tested manually before then.

## Day 4
1. **Silent extra API call from unguarded main().** diagnose.ts's main() ran automatically on import (no require.main === module guard), so importing diagnose() into diagnoseBatch.ts triggered one extra, unlogged diagnosis call before the real batch loop started. This caused the batch to hit Gemini's rate limit one call earlier than expected. Fix: wrapped main() in an explicit require.main === module check so it only auto-runs when the file is executed directly.
2. **429 rate limit mid-batch.** Gemini free tier: 5 requests/minute for gemini-3.6-flash. Batch of 10 diagnosis calls with no delay hit this after ~5-6 calls. Fix: added 13s sleep between calls in diagnoseBatch.ts. Flagged as a constraint for Day 10 (evaluation) and Day 12 (live demo) — full batches must be pre-run and cached, not run live on camera.

## Day 5
1. **diagnoseBatch.ts became a duplicate of diagnose.ts.** At some point diagnoseBatch.ts's real content (the batch loop + verifier integration) was overwritten with a full copy of diagnose.ts's single-event logic, including the old llama-3.3-70b-versatile model name -- explains why fixing diagnose.ts alone didn't resolve the 404. Fix: restored diagnoseBatch.ts to import diagnose() and verify() rather than containing its own copy of either.
2. **Groq deprecated llama-3.3-70b-versatile** (confirmed via Groq's own deprecation notice) -- switched to openai/gpt-oss-120b, their current recommended general-purpose/reasoning model.
3. **9/10 accuracy on batch_1 with Groq (vs 10/10 with Gemini).** One ambiguous-labeled event was confidently misdiagnosed as insufficient_funds. Verifier did not catch it, since the claim didn't contradict the evidence (0 correlated failures is consistent with insufficient_funds) -- it just wasn't the most defensible read of genuinely thin evidence. Verifier checks evidence-consistency, not confidence-calibration on low-information cases. Logged as a known limitation, not patched today (would need a new invariant, e.g. flagging high-confidence claims when error_description is generic and correlation is near-zero).

## Day 6
1. **interveneOnBatch.ts ran on tripled data.** diagnoses table had 3 stale rows per event from repeated Day 5 troubleshooting runs; interveneOnBatch's join against recovery_batches pulled all 3 copies per event with no dedup, producing 30 intervention runs instead of 10. Fix: added a DELETE at the start of diagnoseAllInBatch so every rerun clears prior diagnoses for that batch first, preventing stale accumulation going forward.
2. **Top-level await crashed the CJS build.** Pasted the new DELETE query's await outside diagnoseAllInBatch's function body (at module top level) -- CommonJS output doesn't support top-level await. Fix: moved it inside the async function, as the very first statement.

## Day 7 -- critical bug: idempotency key bound to the wrong identity
1. **Idempotency key used a surrogate database row ID instead of stable business identity.** execute.ts originally built the key as `intervention_${interventionId}`, where interventionId is an auto-increment row ID. Upstream, diagnoseBatch.ts and interveneOnBatch.ts had no guard against re-processing an event that was already diagnosed/actioned -- reruns silently inserted new diagnosis/intervention rows for the same events instead of skipping them. Each new intervention row got a fresh auto-increment ID, which meant a fresh idempotency key, which meant the idempotency check correctly saw "never seen this key" every time -- and dutifully executed a brand-new real Razorpay payment_links.create call. Result: 5 genuine duplicate payment links created in Razorpay test mode across repeated runs, before being caught.
   - No real money moved (test mode throughout), but this is exactly the failure class the whole idempotency design exists to prevent, and it happened because the key was keyed to *how many times we redid the work* rather than *what the work actually was*.
   - Fix (two layers): (1) execute.ts's idempotency key changed to `${eventId}_${finalAction}` -- stable business identity, immune to upstream duplication no matter how many times a row gets re-inserted. (2) diagnoseBatch.ts and interveneOnBatch.ts both got check-before-insert guards (skip if a diagnosis/intervention already exists for this event), fixing the actual source of duplicate rows rather than only patching the symptom at the execution layer.
   - Lesson: an idempotency key must bind to the identity of the *work being done*, never to a database row ID that changes every time the work is accidentally redone.

## Day 8
1. **Agent kept asking for info the backend already had.** First implementation passed customerEmail/amount as function arguments but never included them in the system prompt -- the LLM only reasons over what's in its context, so it correctly (from its own perspective) asked the customer for data it was never given. Fix: built the system prompt per-conversation with known context explicitly stated.
2. **Fix didn't take effect on retest -- stale conversation row.** conversations table already had a row for the test event from the first (buggy) run, with the old contextless system prompt baked into its stored messages. runAgentTurn only builds a fresh system prompt for a brand-new conversation; an existing row reuses its stored history regardless of code changes. Fix: deleted the stale row before retesting. Lesson: when debugging any stateful/persisted conversation or session, check for stale saved state before assuming a code fix didn't work.
3. **NOT NULL constraint on actions.intervention_id blocked conversational payment links.** Migration (ALTER TABLE ... DROP NOT NULL) was run once but silently didn't take -- likely lost in a terminal/psql session mix-up. A real Razorpay payment link was created successfully but the subsequent INSERT into actions failed, meaning the link existed in Razorpay but had no local record -- a real "external action succeeded, internal record failed" integrity gap (harmless in test mode, but the same failure class as Day 7's idempotency lesson: a broken record-keeping step can silently desync your database from real-world state). Fix: reran and verified the ALTER actually applied via \d actions before retrying.

## Day 9 -- first full end-to-end run surfaced two integration bugs, as expected
1. **Accuracy metric silently broke when skip-guards were added.** diagnoseBatch.ts's "correct" counter only incremented inside the per-event loop body, which is skipped entirely for already-diagnosed events (Day 7's guard). First full rerun showed "Accuracy: 0/10" even though all 10 diagnoses were still correct and untouched -- the metric just wasn't checking existing data. Fix: recompute accuracy from a fresh query against current stored diagnoses at the end of the run, independent of what happened to be freshly processed vs skipped in that specific invocation.
2. **psql couldn't display a stored message containing an emoji currency symbol.** SELECT on a conversations.messages row containing an already-correctly-stored rupee symbol (from Day 8) failed with a UTF8/WIN1252 encoding error -- purely a Windows console code-page display issue in this psql session, not a data problem. Fixed for viewing via SET client_encoding = 'UTF8' + jsonb_pretty().

## Day 10
1. **diagnoseBatch.ts's accuracy-recompute fix landed in the wrong scope on a previous edit** -- pasted inside a non-async .catch() block instead of at the end of the async function, causing "await outside async function". Fix: recreated the file cleanly with the fix correctly placed inside diagnoseAllInBatch, before its closing brace.
2. **generateSyntheticBatch.ts got corrupted by a paste-into-already-open-file mistake**, producing duplicate top-level declarations. Fix: deleted and recreated the file cleanly rather than trying to patch duplicated content.
3. **6 real actions failed with Razorpay "Too many requests" during the 25-event evaluation run** (both real payment-link creation and conversational-agent-triggered link generation) -- genuine Razorpay test-mode rate limiting under real API call volume, not a diagnosis bug.
4. **customer20's repeat-failure case never exercised the policy gate's retry cap** -- the diagnosed root causes led to non-retry actions, so the cap remained proven only via an isolated test, not the integrated batch.

## Day 11 -- Track 3 hardening review

### 1. The system called a recovery action "successful" even when no customer had actually paid
**What a recruiter/judge would see:** Recovery OS could report a high recovery rate after successfully creating payment links or starting conversations, even if every customer ignored those links and the business recovered ₹0. That is an action-delivery metric, not a revenue-recovery metric.

**Root cause:** `runEvaluation.ts` treated a successful `actions` row as recovery success. There was no table representing confirmed recovered money and no handler for a later payment-completion webhook.

**Fix:** Recovery payment links now carry the original failed-event ID inside Razorpay `notes`. `payment_link.paid` (and `payment.captured` when the correlation note is present) is handled separately and writes one confirmed row to a new `recoveries` table. The evaluator now reports revenue at risk, confirmed recovered rupees, recovered transaction count and value recovery rate. Creating a link no longer counts as recovered revenue.

**Verification status:** code path implemented; real Razorpay Test Mode payment completion still needs to be exercised locally before this is marked end-to-end proven.

### 2. Anyone who could reach the webhook URL could previously inject a fake payment event
**What this means in English:** The old endpoint trusted the JSON body and event ID header without proving that Razorpay actually sent the request. An attacker or accidental caller could therefore make Recovery OS believe a payment failed and trigger recovery behavior.

**Root cause:** webhook signature verification was missing, and `express.json()` parsed the body before any HMAC validation could be performed.

**Fix:** the Razorpay route now receives the raw request body, verifies `X-Razorpay-Signature` with HMAC-SHA256 and the configured webhook secret, rejects invalid/missing signatures, and only parses/stores the JSON after verification. Event-ID database dedup remains as the second line of defence against replayed delivery.

**Verification status:** deterministic signature test added for valid, invalid and tampered bodies; real Razorpay webhook delivery still needs local testing.

### 3. Safety limits existed in code but the real batch pipeline was feeding them placeholder values
**What this means in English:** Recovery OS claimed that it would stop repeated automated payment attempts and avoid repeatedly contacting a customer, but the integrated batch path always told the policy engine "this customer has had zero recovery attempts and has not been contacted today." The guardrail function was correct in isolation but was not load-bearing in the real flow.

**Root cause:** `interveneOnBatch.ts` hard-coded the policy inputs instead of loading live history.

**Fix:** a runtime policy-context layer now reads the original customer's prior failures, counts automated payment-link attempts for the current failed payment, checks whether that customer was contacted in the last 24 hours, and checks whether the payment has already been recovered. Both batch and webhook-driven recovery paths use these real values.

**Verification status:** policy unit test covers retry cap, repeated-contact block and already-recovered stop; DB-backed integration requires local test data.

### 4. The conversational agent could create a new Razorpay payment link without passing through the main safety policy
**What this means in English:** The main recovery pipeline had a safety gate, but a customer conversation could take a side door: the LLM could request `generate_payment_link`, and that tool called Razorpay directly. A guardrail that can be bypassed by another execution path is not a real guardrail.

**Root cause:** payment-link creation logic was duplicated inside the agent tool instead of being routed through one controlled execution path.

**Fix:** conversational payment-link requests now rebuild current policy context, run the deterministic policy gate, and only then call the same centralized payment-link executor used by automated recovery. The LLM can request the action, but cannot bypass policy or substitute customer identity/amount values.

**Verification status:** code path implemented; conversational Test Mode link creation should be retested after migration.

### 5. Idempotency still had a concurrency race even after the Day 7 duplicate-link fix
**What this means in English:** Day 7 fixed duplicate sequential reruns, but two workers arriving at the same time could both check "no action exists," both call Razorpay, and only then race to insert the same unique key. The database might reject the second INSERT, but Razorpay could already have received two payment-link requests.

**Root cause:** the old pattern was check -> external API call -> insert. Database uniqueness was enforced after the irreversible side effect.

**Fix:** execution now first tries to INSERT a `pending` action row with the unique business idempotency key using `ON CONFLICT DO NOTHING`. Only the worker that successfully claims that row is allowed to call Razorpay. Other workers stop before the external API call. The row is updated to success/failed/error afterward.

**Verification status:** implementation is structurally race-safe at the database claim point; a parallel-process stress test is still desirable.

### 6. `retry_with_backoff` did not actually wait before retrying
**What this means in English:** A bank-outage diagnosis could choose "retry with backoff," but the old executor immediately created another payment link. The action name and real behavior disagreed.

**Fix:** `retry_with_backoff` now creates a scheduled recovery row with a future execution time. A small worker claims due rows and runs them later. `RECOVERY_BACKOFF_SECONDS` can be set low during local testing while keeping a safer default for normal runs.

**Verification status:** migration + worker implemented; timed local test pending.

### 7. The system's own outbound opening message was being treated as if the customer had said it
**What this means in English:** When Recovery OS wanted to start a recovery conversation with "We noticed your payment failed...", it passed that sentence into `runAgentTurn()` as a user message. The model therefore responded to Recovery OS's own sentence as though the customer had sent it.

**Root cause:** one function was being used for two different events: sending the assistant's opening message and processing an actual customer reply.

**Fix:** `startConversation()` now stores the system context and the outbound opening as an `assistant` message without invoking the LLM. `runAgentTurn()` is reserved for genuine customer replies.

**Verification status:** role wiring fixed in code; existing stale conversation rows may need deletion before retesting the same event IDs.

### 8. Offline diagnosis could accidentally use evidence from the future
**What this means in English:** When evaluating an old failed payment, the evidence query could count failures that happened later than that payment. That lets an offline benchmark know information the real-time system could not have known at decision time and can inflate apparent diagnosis quality.

**Root cause:** customer history counted every other failure regardless of timestamp, and same-bank correlation used an absolute time difference that included both earlier and later events.

**Fix:** evidence now uses only failures whose event timestamp is earlier than the event being diagnosed. Same-bank outage evidence is restricted to the preceding 30-minute window. This may lower headline accuracy, but makes the evaluation causally honest.

**Verification status:** query logic changed; the 25-event evaluation must be rerun because the old 96% number is no longer assumed valid.

### 9. Razorpay rate limiting was observed but not handled by the executor
**What this means in English:** When Razorpay returned HTTP 429 under batch load, recovery actions simply failed even though the correct behavior for a temporary service limit is to wait and retry safely.

**Fix:** the centralized payment-link executor now retries HTTP 429 responses up to a bounded maximum, honours `Retry-After` when present, and otherwise uses exponential delay. It does not retry arbitrary network errors, because a lost response after an accepted request can create ambiguity about whether the external side effect happened.

**Verification status:** code implemented; deliberately triggering Test Mode throttling is still needed to confirm observed header/behavior.

### 10. A real `payment.failed` webhook previously stopped at storage instead of driving the recovery pipeline
**What this means in English:** The webhook receiver inserted the event into Postgres, but diagnosis/intervention/execution still depended on separate batch scripts. A live failure was not actually an automatic closed-loop recovery event.

**Fix:** after a valid, newly stored `payment.failed` webhook is acknowledged, the server starts the single-event recovery pipeline: evidence -> diagnosis -> verifier -> intervention -> policy -> execution. Payment-completion webhooks take the separate confirmation path.

**Known remaining limitation:** this handoff is process-local rather than a durable queue. If the Node process crashes after the webhook has been acknowledged but before processing finishes, the event remains safely stored but automatic processing may need replay. A durable queue/worker is a later reliability improvement, not hidden as solved.

### 11. Database state needed new first-class links between a failed event, its actions and the money recovered
**What this means in English:** Previously, conversational actions could exist without a direct event foreign key and there was nowhere to store a confirmed recovery outcome. That made policy queries and financial attribution unnecessarily indirect.

**Fix:** migration `sql/001_track3_hardening.sql` adds `actions.event_id`, backfills it where the intervention chain makes attribution possible, creates the confirmed `recoveries` table, and creates `scheduled_recovery_actions` for real backoff behavior.

**Verification status for Day 11 overall:** code review and syntax-oriented checks completed. Database migration, TypeScript build, local Postgres integration, Groq calls, Razorpay Test Mode link creation and real `payment_link.paid` confirmation are intentionally left for the repository owner to run in the target environment. Any failure found during those tests should be added below this section with the observed symptom, root cause, fix and retest result rather than silently editing the history.