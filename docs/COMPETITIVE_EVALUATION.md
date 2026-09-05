# Competitive Evaluation Methodology

This benchmark exists to make Recovery OS evaluation reproducible and comparable. It is intentionally separate from provider-confirmed revenue accounting.

## What it measures

- 500 deterministic synthetic recovery cases by default
- seeded failure-cause and amount generation
- randomized 50/50 assignment to a control arm or a Recovery OS treatment arm
- transaction recovery rate
- value recovery rate
- recovered-value lift between treatment and control

## What it does **not** measure

The benchmark is a counterfactual simulation. Its recovery probabilities are explicit assumptions used to exercise evaluation mechanics. Therefore:

- benchmark `recoveredAmount` is **simulated**
- it must never be added to `recovery_cases.recovered_amount`
- it must never be presented as provider-confirmed Razorpay revenue
- it does not replace the existing trusted `payment_link.paid -> RECOVERED` outcome contract

The public pitch should keep the two evidence classes separate:

1. **Provider-confirmed runtime proof** — money is counted only after trusted Razorpay Test Mode `payment_link.paid`.
2. **Offline competitive benchmark** — reproducible treatment/control experiment over synthetic scenarios.

## Reproducibility

Default seed: `20260905`

```bash
npm run evaluate:competitive
```

Running the command twice with the same seed and source code produces the same 500 cases and same benchmark result.

## Assumptions

The source file declares cause-specific control and treatment recovery probabilities directly. They are not empirical production rates and should not be described as such. Changing those assumptions changes the benchmark and must be treated as a methodology change rather than silently preserving old headline numbers.
