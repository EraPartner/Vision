/** Monetary preparation and attribution checks from LifeScenarioPanel. No reads or simulation. */
export interface ForecastScenario {
  id: string;
  interruptionMonths: 3;
  monthlySurplus: number;
  monthlyIncomeLoss: number;
  monthlyContribution: number;
  goalValue?: number | undefined;
}
export interface ScenarioForecastInput {
  horizonMonths: number;
  monthlyContribution?: unknown;
  monthlyContributionSchedule?: unknown;
  targetValue?: unknown;
  goalMonth?: unknown;
  seed?: unknown;
  [key: string]: unknown;
}
export interface ScenarioForecastResult {
  available: boolean;
  startValue?: number | null | undefined;
  historyDays?: number | null | undefined;
  expectedAnnualReturn?: number | null | undefined;
  annualVolatility?: number | null | undefined;
  forwardBlend?: number | null | undefined;
  projected?: { p50?: number | null | undefined } | null | undefined;
}
export function prepareLifeScenario<T extends { horizonMonths: number }>(
  scenario: ForecastScenario,
  forecastInput: T,
  goalMonth?: number | undefined,
) {
  const reducedContribution = Math.max(
    0,
    Math.min(
      scenario.monthlyContribution,
      scenario.monthlySurplus - scenario.monthlyIncomeLoss,
    ),
  );
  const common = {
    ...forecastInput,
    monthlyContribution: scenario.monthlyContribution,
    targetValue: scenario.goalValue,
    goalMonth,
    seed: `life-scenario:${scenario.id}`,
  };
  return {
    baselineInput: common,
    interruptedInput: {
      ...common,
      monthlyContributionSchedule: Array.from(
        { length: scenario.interruptionMonths },
        () => reducedContribution,
      ),
    },
    goalMonth,
    reducedContribution,
    monthlyDeficit: Math.max(
      0,
      scenario.monthlyIncomeLoss - scenario.monthlySurplus,
    ),
  };
}
export function areLifeScenarioForecastsComparable(
  baseline: ScenarioForecastResult,
  interrupted: ScenarioForecastResult,
): boolean {
  const comparableInputs = [
    "startValue",
    "historyDays",
    "expectedAnnualReturn",
    "annualVolatility",
    "forwardBlend",
  ] as const;
  return !comparableInputs.some(
    (field) => baseline[field] !== interrupted[field],
  );
}
export function compareLifeScenarioForecasts(
  baseline: ScenarioForecastResult,
  interrupted: ScenarioForecastResult,
) {
  const comparable = areLifeScenarioForecastsComparable(baseline, interrupted);
  const available = comparable && baseline.available && interrupted.available;
  const medianGap =
    available &&
    interrupted.projected?.p50 !== undefined &&
    baseline.projected?.p50 !== undefined
      ? (interrupted.projected.p50 as number) -
        (baseline.projected.p50 as number)
      : null;
  return {
    comparable,
    available,
    medianGap,
    errorKey: comparable ? null : "research.lifeScenario.inputsChanged",
  };
}
