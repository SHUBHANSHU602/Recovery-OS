import assert from "node:assert/strict";
import { generateBenchmarkCases, runCompetitiveBenchmark } from "./competitiveBenchmark";

const first = generateBenchmarkCases(500, 20260905);
const second = generateBenchmarkCases(500, 20260905);
assert.deepEqual(first, second, "same seed must reproduce the exact benchmark dataset");
assert.equal(first.length, 500);
assert.ok(first.some((item) => item.arm === "control"));
assert.ok(first.some((item) => item.arm === "recovery_os"));
assert.ok(first.every((item) => item.amountAtRisk >= 10000 && item.amountAtRisk <= 1000000));
assert.ok(first.every((item) => item.recoveredAmount === 0 || item.recoveredAmount === item.amountAtRisk));

const result = runCompetitiveBenchmark(500, 20260905);
assert.equal(result.totalCases, 500);
assert.equal(result.control.cases + result.recoveryOs.cases, 500);
assert.ok(result.control.valueRecoveryRate >= 0 && result.control.valueRecoveryRate <= 100);
assert.ok(result.recoveryOs.valueRecoveryRate >= 0 && result.recoveryOs.valueRecoveryRate <= 100);
assert.equal(result.lift.recoveredValueDelta, result.recoveryOs.recoveredAmount - result.control.recoveredAmount);

console.log("Competitive benchmark tests passed.");
