# Debug Log

## Day 1
1. **International test card rejected.** Used 4111 1111 1111 1111 (generic international Visa test number) — account only accepts domestic cards. Fix: used Razorpay's documented Indian-scenario test cards (4100 2800 0009 0000).
2. **ts-node MODULE_NOT_FOUND on valid path.** ts-node failed to resolve src/ingestion/server.ts on Windows + Node 24.11.0 — internal project-dir resolution bug. Tried tsx as an alternative, hit a separate ESM resolution error. Fix: deferred TypeScript to Day 4, wrote Day 1's webhook receiver in plain CommonJS JS to stay unblocked.
3. **Error code mismatch in webhook payload.** Test card selected for payment_timed_out scenario, but the actual webhook payload showed error_code: BAD_REQUEST_ERROR instead. Manual "Failure" click in test mode doesn't preserve the specific test-card error type. Noted for Day 3: synthetic batch generator will be the reliable source of varied error codes, not manual test-mode failures.