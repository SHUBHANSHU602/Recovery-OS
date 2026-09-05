type Cause = "insufficient_funds" | "expired_card" | "systemic_bank_outage" | "ambiguous";
type Arm = "control" | "recovery_os";

export interface BenchmarkCase {
  id: number;
  amountAtRisk: number;
  cause: Cause;
  arm: Arm;
  recoveryProbability: number;
  recovered: boolean;
  recoveredAmount: number;
}

export interface ArmMetrics {
  cases: number;
  amountAtRisk: number;
  recoveredCases: number;
  recoveredAmount: number;
  transactionRecoveryRate: number;
  valueRecoveryRate: number;
}

export interface BenchmarkResult {
  seed: number;
  totalCases: number;
  control: ArmMetrics;
  recoveryOs: ArmMetrics;
  lift: {
    transactionRecoveryPoints: number;
    valueRecoveryPoints: number;
    recoveredValueDelta: number;
  };
}

const CAUSES: Cause[] = ["insufficient_funds", "expired_card", "systemic_bank_outage", "ambiguous"];
const CAUSE_WEIGHTS = [0.34, 0.22, 0.3, 0.14];
const CONTROL_PROBABILITY: Record<Cause, number> = { insufficient_funds: 0.08, expired_card: 0.05, systemic_bank_outage: 0.12, ambiguous: 0.03 };
const TREATMENT_PROBABILITY: Record<Cause, number> = { insufficient_funds: 0.24, expired_card: 0.36, systemic_bank_outage: 0.58, ambiguous: 0.08 };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chooseCause(random: () => number): Cause {
  const value = random();
  let cursor = 0;
  for (let index = 0; index < CAUSES.length; index += 1) {
    cursor += CAUSE_WEIGHTS[index];
    if (value < cursor) return CAUSES[index];
  }
  return CAUSES[CAUSES.length - 1];
}

function summarize(cases: BenchmarkCase[], arm: Arm): ArmMetrics {
  const selected = cases.filter((item) => item.arm === arm);
  const amountAtRisk = selected.reduce((sum, item) => sum + item.amountAtRisk, 0);
  const recoveredAmount = selected.reduce((sum, item) => sum + item.recoveredAmount, 0);
  const recoveredCases = selected.filter((item) => item.recovered).length;
  return {
    cases: selected.length,
    amountAtRisk,
    recoveredCases,
    recoveredAmount,
    transactionRecoveryRate: selected.length > 0 ? (recoveredCases / selected.length) * 100 : 0,
    valueRecoveryRate: amountAtRisk > 0 ? (recoveredAmount / amountAtRisk) * 100 : 0,
  };
}

export function generateBenchmarkCases(totalCases = 500, seed = 20260905): BenchmarkCase[] {
  if (!Number.isInteger(totalCases) || totalCases <= 0) throw new Error("totalCases must be a positive integer");
  const random = mulberry32(seed);
  const cases: BenchmarkCase[] = [];
  for (let id = 1; id <= totalCases; id += 1) {
    const cause = chooseCause(random);
    const amountAtRisk = 10000 + Math.floor(random() * 990001);
    const arm: Arm = random() < 0.5 ? "control" : "recovery_os";
    const recoveryProbability = arm === "control" ? CONTROL_PROBABILITY[cause] : TREATMENT_PROBABILITY[cause];
    const recovered = random() < recoveryProbability;
    cases.push({ id, amountAtRisk, cause, arm, recoveryProbability, recovered, recoveredAmount: recovered ? amountAtRisk : 0 });
  }
  return cases;
}

export function runCompetitiveBenchmark(totalCases = 500, seed = 20260905): BenchmarkResult {
  const cases = generateBenchmarkCases(totalCases, seed);
  const control = summarize(cases, "control");
  const recoveryOs = summarize(cases, "recovery_os");
  return {
    seed,
    totalCases,
    control,
    recoveryOs,
    lift: {
      transactionRecoveryPoints: recoveryOs.transactionRecoveryRate - control.transactionRecoveryRate,
      valueRecoveryPoints: recoveryOs.valueRecoveryRate - control.valueRecoveryRate,
      recoveredValueDelta: recoveryOs.recoveredAmount - control.recoveredAmount,
    },
  };
}

function money(paise: number): string { return `₹${(paise / 100).toFixed(2)}`; }
function percent(value: number): string { return `${value.toFixed(1)}%`; }

if (require.main === module) {
  const result = runCompetitiveBenchmark();
  console.log("========== OFFLINE COMPETITIVE BENCHMARK ==========");
  console.log(`Seed: ${result.seed}`);
  console.log(`Cases: ${result.totalCases}`);
  console.log("NOTE: synthetic counterfactual benchmark; NOT provider-confirmed recovered revenue.");
  console.log("");
  console.log(`Control: ${result.control.recoveredCases}/${result.control.cases} transactions, ${percent(result.control.transactionRecoveryRate)}; ${money(result.control.recoveredAmount)} / ${money(result.control.amountAtRisk)} value, ${percent(result.control.valueRecoveryRate)}`);
  console.log(`Recovery OS treatment: ${result.recoveryOs.recoveredCases}/${result.recoveryOs.cases} transactions, ${percent(result.recoveryOs.transactionRecoveryRate)}; ${money(result.recoveryOs.recoveredAmount)} / ${money(result.recoveryOs.amountAtRisk)} value, ${percent(result.recoveryOs.valueRecoveryRate)}`);
  console.log(`Lift: ${result.lift.transactionRecoveryPoints.toFixed(1)} transaction points; ${result.lift.valueRecoveryPoints.toFixed(1)} value points; ${money(result.lift.recoveredValueDelta)} simulated recovered-value delta`);
}
