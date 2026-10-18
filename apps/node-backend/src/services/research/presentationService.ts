import { z } from "zod";
import { parseInput } from "../../lib/zodInput.ts";
import {
  comparePresentation,
  chartPresentation,
  watchlistPresentation,
  watchlistListPresentation,
  analystPresentation,
  providerQuotePresentation,
} from "@vision/shared-utils/research/presentation";
import { deriveUnitMath } from "@vision/shared-utils/research/unitMath";

import {
  prepareLifeScenario,
  compareLifeScenarioForecasts,
} from "@vision/shared-utils/research/forecastScenario";

export const RESEARCH_PRESENTATION_MAX_BYTES = 64 * 1024 * 1024;
const point = z.object({
  time: z.number(),
  close: z.number().nullable().optional(),
  high: z.number().nullable().optional(),
  low: z.number().nullable().optional(),
  volume: z.number().nullable().optional(),
});
const boundedId = z.string().min(1).max(128);
const watchlistFields = {
  targetPrice: z.number().nullable(),
  currentPrice: z.number().nullable(),
  addedPrice: z.number().nullable(),
};
const chart = z
  .object({
    kind: z.literal("chart"),
    series: z
      .array(
        z.object({
          id: boundedId,
          field: z.enum(["price", "volume"]),
          type: z.enum(["line", "area", "candlestick", "bar"]),
          points: z.array(point),
        }),
      )
      .max(5),
    indicators: z
      .array(
        z.object({
          id: boundedId,
          type: z.enum(["sma", "ema", "bollinger"]),
          period: z.number().int().min(1).max(500),
          seriesId: boundedId,
        }),
      )
      .max(20),
    rebase: z.boolean(),
    oscillator: z.enum(["none", "rsi", "macd"]),
    oscillatorSeriesId: boundedId.nullable(),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.series.map((s) => s.id));
    if (ids.size !== value.series.length)
      ctx.addIssue({ code: "custom", message: "Series ids must be unique" });
    if (
      new Set(value.indicators.map((i) => i.id)).size !==
      value.indicators.length
    )
      ctx.addIssue({ code: "custom", message: "Indicator ids must be unique" });
    for (const ind of value.indicators)
      if (!ids.has(ind.seriesId))
        ctx.addIssue({
          code: "custom",
          message: "Indicator source must exist",
        });
  });
const lifeScenarioPrepare = z
  .object({
    kind: z.literal("lifeScenarioPrepare"),
    scenario: z.looseObject({
      id: z.string().min(1),
      kind: z.literal("income_interruption").optional(),
      interruptionMonths: z.literal(3),
      monthlySurplus: z.number().min(0),
      monthlyIncomeLoss: z.number().min(0),
      monthlyContribution: z.number().min(0),
      goalValue: z.number().positive().optional(),
    }),
    forecastInput: z.looseObject({
      horizonMonths: z.number().int().min(1).max(600),
    }),
    goalMonth: z.number().int().positive().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scenario.monthlyContribution > value.scenario.monthlySurplus)
      ctx.addIssue({
        code: "custom",
        message: "research.lifeScenario.invalid",
      });
    if (
      (value.goalMonth != null) !== (value.scenario.goalValue !== undefined) ||
      (value.goalMonth != null &&
        value.goalMonth > value.forecastInput.horizonMonths)
    )
      ctx.addIssue({
        code: "custom",
        message: "research.lifeScenario.invalid",
      });
  });
const forecastComparisonInput = z.looseObject({
  available: z.boolean(),
  startValue: z.number().nullable().optional(),
  historyDays: z.number().nullable().optional(),
  expectedAnnualReturn: z.number().nullable().optional(),
  annualVolatility: z.number().nullable().optional(),
  forwardBlend: z.number().nullable().optional(),
  projected: z
    .looseObject({ p50: z.number().nullable().optional() })
    .nullable()
    .optional(),
});
const schema = z.discriminatedUnion("kind", [
  lifeScenarioPrepare,
  z
    .object({
      kind: z.literal("lifeScenarioCompare"),
      baseline: forecastComparisonInput,
      interrupted: forecastComparisonInput,
    })
    .superRefine((value, ctx) => {
      // The maintained forecast client rejects available numeric-null projections.
      // Do not let JS null coercion manufacture a median difference for that failure.
      if (
        [value.baseline, value.interrupted].some(
          (result) => result.available && result.projected?.p50 === null,
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Available forecast median must be numeric",
        });
    }),
  z.object({
    kind: z.literal("compare"),
    series: z
      .array(
        z.object({ symbol: z.string().min(1).max(64), points: z.array(point) }),
      )
      .max(6),
  }),
  chart,
  z.object({
    kind: z.literal("watchlist"),
    ...watchlistFields,
    points: z.array(point).default([]),
  }),
  z.object({
    kind: z.literal("watchlistBatch"),
    entries: z
      .array(
        z.object({
          id: z.number().int().positive(),
          targetPrice: z.number(),
          currentPrice: z.number().nullable(),
          addedPrice: z.number().nullable(),
        }),
      )
      .max(5000),
  }),
  z.object({
    kind: z.literal("providerQuote"),
    points: z.array(point),
    investment: z.object({
      symbol: z.string().nullable().optional(),
      name: z.string(),
      currency: z.string(),
      priceProvider: z.string().nullable().optional(),
    }),
    selectedSymbol: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("analyst"),
    consensus: z
      .object({
        strongBuy: z.number(),
        buy: z.number(),
        hold: z.number(),
        sell: z.number(),
        strongSell: z.number(),
      })
      .nullable(),
  }),
  z.object({
    kind: z.literal("marketAdd"),
    amount: z.number().positive().optional(),
    units: z.number().positive().optional(),
    price: z.number().positive().optional(),
    derive: z.boolean().optional(),
  }),
]);
export function computeResearchPresentation(input: unknown) {
  const value = parseInput(schema, input);
  switch (value.kind) {
    case "lifeScenarioPrepare":
      return {
        kind: value.kind,
        result: prepareLifeScenario(
          value.scenario,
          value.forecastInput,
          value.goalMonth ?? undefined,
        ),
      };
    case "lifeScenarioCompare":
      return {
        kind: value.kind,
        result: compareLifeScenarioForecasts(value.baseline, value.interrupted),
      };
    case "compare":
      return { kind: value.kind, result: comparePresentation(value.series) };
    case "chart":
      return { kind: value.kind, result: chartPresentation(value) };
    case "watchlist":
      return { kind: value.kind, result: watchlistPresentation(value) };
    case "watchlistBatch":
      return {
        kind: value.kind,
        result: {
          entries: value.entries.map((e) => ({
            id: e.id,
            list: watchlistListPresentation(
              e.targetPrice,
              e.currentPrice,
              e.addedPrice,
            ),
          })),
        },
      };
    case "providerQuote":
      return {
        kind: value.kind,
        result: providerQuotePresentation(
          value.points,
          value.investment,
          value.selectedSymbol,
        ),
      };
    case "analyst":
      return { kind: value.kind, result: analystPresentation(value.consensus) };
    case "marketAdd":
      return { kind: value.kind, result: deriveUnitMath(value) };
  }
}
