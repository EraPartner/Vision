import { describe, expect, it } from "vitest";
import {
    prepareLifeScenario,
    compareLifeScenarioForecasts,
    type ForecastScenario,
    type ScenarioForecastResult,
} from "@vision/shared-utils/research/forecastScenario";
import golden from "./forecastScenario.golden.json";
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
describe("LifeScenario immutable-source goldens", () => {
    for (const item of golden.cases)
        it(item.name, () => {
            const input = item.input;
            const output =
                input.kind === "lifeScenarioPrepare"
                    ? prepareLifeScenario(
                          input.scenario as ForecastScenario,
                          input.forecastInput as { horizonMonths: number },
                          input.goalMonth,
                      )
                    : compareLifeScenarioForecasts(
                          input.baseline as ScenarioForecastResult,
                          input.interrupted as ScenarioForecastResult,
                      );
            expect(json(output)).toEqual(item.expected);
        });
    it("retains strict undefined/NaN semantics in the exact five comparison fields", () => {
        expect(
            compareLifeScenarioForecasts(
                { available: true, startValue: NaN },
                { available: true, startValue: NaN },
            ).errorKey,
        ).toBe("research.lifeScenario.inputsChanged");
        expect(
            compareLifeScenarioForecasts(
                { available: true, projected: { p50: 10 } },
                { available: true, projected: { p50: 10 } },
            ).medianGap,
        ).toBe(0);
    });
});
