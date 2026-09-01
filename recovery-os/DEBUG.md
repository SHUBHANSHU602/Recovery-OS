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
   - Lesson for the README/pitch: an idempotency key must bind to the identity of the *work being done*, never to a database row ID that changes every time the work is accidentally redone. This is worth stating explicitly as a design principle, not just a bug fix -- it's the kind of mistake that's easy to make and expensive in a real production system.