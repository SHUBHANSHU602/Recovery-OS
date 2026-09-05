# Debug Log

## 2026-09-05 — AI planner benchmark underperformed static rules

### Failure
`npm run evaluate:ai` was run three times against the 12-scenario contextual decision benchmark.

Observed results before the fix:
- Static rules + shared deterministic policy: 9/12 (75.0%) on every run.
- AI planner + shared deterministic policy: 7/12 (58.3%), 7/12 (58.3%), and 6/12 (50.0%).

Repeated wrong or unstable decisions included:
- choosing another automated action after retry exhaustion instead of escalating,
- replacing the initial insufficient-funds nudge with an alternate-payment action,
- choosing alternate payment for an overdue Promise-to-Pay instead of a bounded reminder,
- failing to stop repeated outage retries when comparable retry outcomes were poor,
- failing to escalate repeated unresolved expired-card alternate-method attempts.

### Root cause
The planner prompt supplied rich context but left several business invariants implicit. The model could therefore choose a plausible alternate action that bypassed the intended bounded recovery behavior. The Groq planner call also did not set a deterministic temperature, so equivalent runs varied.

This was not treated as a benchmark-only issue. The same ambiguity could affect live replanning because the production recovery pipeline uses the same planner.

### Fix
Updated `src/agent/recoveryPlanner.ts` to:
1. set `temperature: 0` for stable planner inference,
2. make the planner prompt explicitly prioritize bounded recovery semantics,
3. add deterministic, context-derived business guardrails between the model recommendation and the existing policy gate.

The guardrails do not inspect benchmark scenario ids. They operate on live business state such as:
- diagnosis confidence/root cause,
- automated retry count,
- recent contact count,
- trigger type,
- previous unresolved action,
- customer failure count,
- comparable strategy outcome evidence.

Guardrails currently enforce these general invariants:
- ambiguous or low-confidence evidence abstains to human review,
- exhausted automated retry budget escalates,
- a due unpaid Promise-to-Pay cannot route around an already-consumed contact budget,
- high-signal initial failures follow failure semantics before contextual replanning,
- repeated unresolved expired-card alternate-method recovery escalates instead of switching to another unsolicited contact,
- an unresolved insufficient-funds nudge can switch to retry only when comparable retry history is materially stronger,
- repeated outage retries with sufficiently poor comparable outcomes escalate rather than repeat mechanically.

The original deterministic policy gate remains authoritative after planner guardrails.

### Regression coverage
Updated `src/agent/testFinalAi.ts` with deterministic assertions for:
- retry exhaustion,
- ambiguity/low confidence,
- initial insufficient-funds behavior,
- Promise-to-Pay contact-cap behavior,
- strategy change after failed nudge with stronger retry evidence,
- stopping poor repeated outage retries.

### Validation completed locally
Validation commands run:

```powershell
npm run test:ai
npm run evaluate:ai
npm run evaluate:ai
npm run test:core
```

Observed results after the fix:
- `npm run test:ai` -> PASS (`Final AI recovery-agent deterministic tests passed.`)
- `npm run evaluate:ai` run 1 -> Static rules + policy: 9/12 (75.0%); AI planner + policy: 12/12 (100.0%)
- `npm run evaluate:ai` run 2 -> Static rules + policy: 9/12 (75.0%); AI planner + policy: 12/12 (100.0%)
- Both benchmark runs returned the same action for every scenario, including the contextual cases where static root-cause rules miss the expected action.
- `npm run test:core` -> PASS across typecheck, policy, verifier, dashboard, intelligence, channels, competitive benchmark, and final AI tests.

Acceptance criteria are satisfied:
- deterministic AI regression tests pass,
- repeated benchmark runs are stable,
- AI+guardrails no longer underperform the static-rule baseline on the labeled contextual benchmark,
- full core regression suite remains green.

### Evidence / claims note
Do not claim that this benchmark is provider-confirmed revenue lift. It measures labeled contextual decision quality with the same deterministic policy controls applied after planning.

The validated claim is: on this 12-scenario labeled contextual decision benchmark, static rules + policy scored 9/12 (75.0%) while AI planner + deterministic business guardrails + the same policy controls scored 12/12 (100.0%) on two consecutive local runs.
