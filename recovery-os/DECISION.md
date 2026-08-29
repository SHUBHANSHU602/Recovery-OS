### ALL THE IMPORTANT DECISIONS ARE STORED HERE
---

- All amounts stored/handled in paise (Razorpay's native unit); convert to rupees only at display time.
- ts-node failed to resolve entry file on Windows/Node 24 (MODULE_NOT_FOUND on a valid path); tsx hit a separate ESM resolution error on the same setup; switched Day-1 webhook receiver to plain CommonJS JS to unblock, deferred TypeScript to Day 4 when structured-output validation actually needs it.
- Expected error_code to reflect the specific test-card scenario (payment_timed_out); got generic BAD_REQUEST_ERROR/payment_failed instead — test-mode manual Failure click doesn't preserve the card's intended error type.


# Decisions Log

## Day 1
- LLM provider: Anthropic Claude — matches Razorpay's own stack (Agent Studio built on Claude Agent SDK, NPCI agentic-payments pilot runs on Claude).
- Language/runtime: Node.js — I/O-bound service (webhooks, DB, LLM calls) fits Node's async model; TypeScript deferred to Day 4 (see below).
- TypeScript deferred for Day 1: ts-node and tsx both hit unresolved Windows/Node-24 module resolution errors on this machine. Day 1's webhook receiver is trivial and doesn't need type safety yet — switched to plain CommonJS JS to stay unblocked. Revisit TypeScript on Day 4 when structured LLM output validation actually needs it.
- Orchestration: plain hand-rolled pipeline, not LangGraph — the loop is linear with one branch (escalation); a framework built for complex multi-agent graphs is unnecessary complexity here.
- Memory/retrieval: no vector DB — diagnosis works off structured evidence (error codes, correlated failures, payment history), which is a SQL problem, not semantic search.
- Deployment: Docker Compose, local — buildathon asks for a public repo + pitch video + architecture doc, not confirmed live hosting.


## Day 2
- TypeScript brought in now (originally planned for Day 4) — user requested it early for the DB layer; switched from ts-node (broken on Day 1) to tsx, which works cleanly.
- Schema: `events` table uses a SERIAL `id` as primary key + a separate UNIQUE `event_id` column, not event_id as PK directly — keeps internal identity independent of Razorpay's external ID scheme, useful if a second payment provider is ever added.
- Dedup enforced at the database level via UNIQUE constraint + catching Postgres error code 23505, not via an application-level "check then insert" — avoids a race-condition window between check and insert.
- Payload stored as JSONB (not fixed columns) — evidence-gathering/diagnosis field needs aren't fully known yet; JSONB preserves everything and stays queryable.
- Moved DB credentials from hardcoded values in server.ts to .env (via dotenv) + .gitignore — server.ts will be in a public repo.


## Day 3
- Evidence gathered per event: error code/description (from the event itself), customer failure history count, and correlated-failures-at-same-bank count within a 30-minute window — matches the three-signal design in the handoff doc.
- Synthetic batch generator (recovery_batches table) creates labeled events with a known ground-truth cause, so Day 4 diagnosis accuracy becomes a measurable metric instead of a guess.
- recovery_batches.event_id is a foreign key into events(event_id) — Postgres physically rejects an orphaned synthetic label, keeping ground-truth data always in sync with real event rows.


## Day 4
- LLM provider switched from Anthropic Claude to Google Gemini (gemini-3.6-flash) — practical constraint: Gemini key already available free, Anthropic API is paid. Original pitch angle ("matches Razorpay's Claude-based stack") no longer applies; architecture (evidence -> diagnosis -> verifier -> policy gate) is the actual differentiator.
- Diagnosis structured output enforced via Gemini's forced function-calling (functionCallingConfig.mode: "ANY" + allowedFunctionNames) — same role as tool_choice, guarantees root_cause is always one of four enum values.
- diagnose.ts and gatherEvidence.ts both export their core functions so diagnoseBatch.ts (and later scripts) reuse the same logic rather than duplicating it — avoids evidence-gathering implementations drifting apart.
- Gemini free tier caps at 5 requests/minute for gemini-3.6-flash — added a 13s delay between diagnosis calls in batch runs. Fine for the real webhook loop (events arrive one at a time in practice), but means full batch evaluation (Day 10) and any live demo (Day 12) must use pre-run/cached results rather than running the whole batch on camera. Revisit paid tier before submission if budget allows.



