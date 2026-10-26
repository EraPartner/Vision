import { describe, expect, it } from "vitest";
import {
    comparePresentation,
    chartPresentation,
    watchlistPresentation,
    analystPresentation,
    providerQuotePresentation,
} from "@vision/shared-utils/research/presentation";
import { deriveUnitMath } from "@/lib/portfolioUnitMath";
import fixture from "./presentation.golden.json";
import type {
    ChartPresentationSeries,
    ChartPresentationIndicator,
} from "@vision/shared-utils/research/types";
import { must } from "@/test/must";

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
describe("Research shared presentation source goldens", () => {
    for (const item of fixture.cases)
        it(item.name, () => {
            const input = item.input;
            const output =
                input.kind === "compare"
                    ? comparePresentation(
                          input.series as {
                              symbol: string;
                              points: { time: number; close: number | null }[];
                          }[],
                      )
                    : chartPresentation({
                          ...input,
                          series: input.series as ChartPresentationSeries[],
                          indicators:
                              input.indicators as ChartPresentationIndicator[],
                          rebase: must(input.rebase),
                          oscillator: input.oscillator as
                              "none" | "rsi" | "macd",
                          oscillatorSeriesId: input.oscillatorSeriesId ?? null,
                      });
            expect(json(output)).toEqual(item.expected);
        });
    it("retains distinct list/chart/preview target conventions and first-zero provider quote", () => {
        expect(
            watchlistPresentation({
                targetPrice: 10,
                currentPrice: 8,
                addedPrice: 4,
                points: [],
            }),
        ).toEqual({
            list: {
                distancePercent: -20,
                absoluteDistancePercent: 20,
                isAtOrBelowTarget: true,
                sinceAddedPercent: 100,
            },
            chart: {
                distancePercent: -20,
                absoluteDistancePercent: 20,
                isAtOrBelowTarget: true,
                hasValidTarget: true,
                domain: [9.8, 10.2],
            },
            preview: { absolutePercent: 25, direction: "above" },
        });
        expect(
            watchlistPresentation({
                targetPrice: 8,
                currentPrice: 8,
                addedPrice: null,
                points: [],
            }).preview,
        ).toEqual({ absolutePercent: 0, direction: "above" });
        expect(
            watchlistPresentation({
                targetPrice: 0,
                currentPrice: 8,
                addedPrice: null,
                points: [],
            }).chart,
        ).toEqual({
            distancePercent: null,
            absoluteDistancePercent: null,
            isAtOrBelowTarget: false,
            hasValidTarget: false,
            domain: [0, 1],
        });
        expect(
            providerQuotePresentation(
                [
                    { time: 1, close: 0 },
                    { time: 2, close: 8 },
                ],
                { name: "Metal", currency: "USD", priceProvider: "kinesis" },
            ),
        ).toMatchObject({
            price: 8,
            change: 8,
            changePercent: 0,
            type: "KINESIS",
            currency: "USD",
        });
    });
    it("retains consensus thresholds and two-of-three rounding/tolerance", () => {
        expect(
            analystPresentation({
                strongBuy: 6,
                buy: 0,
                hold: 4,
                sell: 0,
                strongSell: 0,
            }),
        ).toMatchObject({
            verdictKey: "market.strongBuy",
            tone: "success",
            bullFraction: 0.6,
        });
        expect(
            analystPresentation({
                strongBuy: 0,
                buy: 0,
                hold: 11,
                sell: 9,
                strongSell: 0,
            }),
        ).toMatchObject({ verdictKey: "market.sell", bearFraction: 0.45 });
        expect(
            analystPresentation({
                strongBuy: 0,
                buy: 0,
                hold: 0,
                sell: 0,
                strongSell: 0,
            }),
        ).toBeNull();
        expect(
            deriveUnitMath({ amount: 100, units: 3, price: 33.33 })
                .isConsistent,
        ).toBe(true);
        expect(deriveUnitMath({ amount: 100, units: 3 })).toMatchObject({
            derivedPrice: 33.333333,
            effectivePrice: 33.333333,
            isConsistent: true,
        });
    });
});
