import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import router from "../../src/routes/researchPresentation.ts";
import { routeAgent } from "../helpers/routeApp.ts";
import { bodyAt } from "../helpers/responseBody.ts";
const api = routeAgent(router, { mountPath: "/api/research" });
const post = (value: unknown) =>
  api
    .post("/api/research/presentation")
    .attach("file", Buffer.from(JSON.stringify(value)), "life.json");
const golden: { cases: { name: string; input: unknown; expected: unknown }[] } =
  JSON.parse(
    readFileSync(
      new URL(
        "../../../frontend/src/lib/research/__tests__/forecastScenario.golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const scenario = {
  id: "saved",
  interruptionMonths: 3,
  monthlySurplus: 900,
  monthlyIncomeLoss: 700,
  monthlyContribution: 500,
};
describe("Stateless LifeScenario bridge", () => {
  for (const item of golden.cases)
    it(item.name, async () => {
      const result = await post(item.input);
      expect(result.status).toBe(200);
      expect(bodyAt(result, "data", "result")).toEqual(item.expected);
    });
  it.each([
    "startValue",
    "historyDays",
    "expectedAnnualReturn",
    "annualVolatility",
    "forwardBlend",
  ])("checks %s and no new attribution fields", async (field) => {
    const result = await post({
      kind: "lifeScenarioCompare",
      baseline: { available: true, [field]: 1, projected: { p50: 100 } },
      interrupted: { available: true, [field]: 2, projected: { p50: 90 } },
    });
    expect(bodyAt(result, "data", "result")).toEqual({
      comparable: false,
      available: false,
      medianGap: null,
      errorKey: "research.lifeScenario.inputsChanged",
    });
  });
  it("treats null/null comparison fields as equal without treating null medians as zero", async () => {
    const result = await post({
      kind: "lifeScenarioCompare",
      baseline: { available: true, startValue: null, projected: { p50: 100 } },
      interrupted: {
        available: true,
        startValue: null,
        projected: { p50: 90 },
      },
    });
    expect(bodyAt(result, "data", "result")).toEqual({
      comparable: true,
      available: true,
      medianGap: -10,
      errorKey: null,
    });
    expect(
      (
        await post({
          kind: "lifeScenarioCompare",
          baseline: { available: true, projected: { p50: null } },
          interrupted: { available: true, projected: { p50: 10 } },
        })
      ).status,
    ).toBe(400);
  });
  it.each([
    {
      kind: "lifeScenarioPrepare",
      scenario: { ...scenario, interruptionMonths: 2 },
      forecastInput: { horizonMonths: 12 },
    },
    {
      kind: "lifeScenarioPrepare",
      scenario: { ...scenario, monthlyContribution: 1000 },
      forecastInput: { horizonMonths: 12 },
    },
    {
      kind: "lifeScenarioPrepare",
      scenario: { ...scenario, monthlyIncomeLoss: -1 },
      forecastInput: { horizonMonths: 12 },
    },
    {
      kind: "lifeScenarioPrepare",
      scenario: { ...scenario, goalValue: 100 },
      forecastInput: { horizonMonths: 12 },
    },
    {
      kind: "lifeScenarioPrepare",
      scenario: { ...scenario, goalValue: 100 },
      goalMonth: 13,
      forecastInput: { horizonMonths: 12 },
    },
    {
      kind: "lifeScenarioPrepare",
      scenario,
      goalMonth: 3,
      forecastInput: { horizonMonths: 12 },
    },
    {
      kind: "lifeScenarioCompare",
      baseline: { available: true, startValue: "1" },
      interrupted: { available: true },
    },
  ])("rejects unsupported scenario shape %#", async (input) => {
    const result = await post(input);
    expect(result.status).toBe(400);
    expect(bodyAt(result, "error", "code")).toBe("VALIDATION_ERROR");
  });
  it("normalizes omitted/null goalMonth while clearing discarded main goal", async () => {
    const result = await post({
      kind: "lifeScenarioPrepare",
      scenario,
      forecastInput: {
        horizonMonths: 12,
        targetValue: 1000,
        goalMonth: 99,
        monthlyContribution: null,
        seed: "old",
      },
      goalMonth: null,
    });
    expect(bodyAt(result, "data", "result", "baselineInput")).toEqual({
      horizonMonths: 12,
      monthlyContribution: 500,
      seed: "life-scenario:saved",
    });
  });
});

describe("Existing forecast nullable wire boundary", () => {
  it("proves large finite contributions serialize unknown money without changing engine/client guards", async () => {
    const { runPortfolioForecast } =
      await import("../../src/services/research/projection/portfolioProjection.ts");
    const { PortfolioForecastSchema } = await import("@vision/types/contracts");
    type Deps = NonNullable<Parameters<typeof runPortfolioForecast>[1]>;
    const snapshots = Array.from({ length: 100 }, (_, i) => ({
      value: 1000 * Math.exp(i * 0.0005),
      snapshot_date: `2026-01-${i}`,
    }));
    const deps = {
      getPortfolioSummary: async () => ({
        totals: { totalPortfolioValue: 1000 },
        summaries: [],
      }),
      getSnapshots: async () => snapshots,
      aggregator: { fetch: async () => ({ source: "unavailable" }) },
      today: () => "2026-10-13",
    } as unknown as Deps;
    const result = await runPortfolioForecast(
      {
        horizonMonths: 3,
        paths: 100,
        monthlyContribution: 1e308,
        seed: "overflow-wire",
      },
      deps,
    );
    const wire: unknown = JSON.parse(JSON.stringify(result));
    expect(bodyAt({ body: wire }, "available")).toBe(true);
    expect(bodyAt({ body: wire }, "monthlyContribution")).toBeNull();
    expect(bodyAt({ body: wire }, "netInvested")).toBeNull();
    expect(bodyAt({ body: wire }, "projected", "p50")).toBeNull();
    expect(PortfolioForecastSchema.safeParse(wire).success).toBe(false);
    const response = await post({
      kind: "lifeScenarioCompare",
      baseline: wire,
      interrupted: wire,
    });
    expect(response.status).toBe(400);
  });
});
