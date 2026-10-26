import { isNonZeroNumber } from "../numeric.ts";
import {
  computeStats,
  dailyReturnsByTime,
  pearsonOnTime,
  rebaseTo100,
} from "./compare.ts";
import { sma, ema, bollinger, rsi, macd } from "./indicators.ts";
import type {
  ResearchPoint,
  ResearchRow,
  ChartPresentationSeries,
  ChartPresentationIndicator,
} from "./types.ts";

export function comparePresentation(
  series: { symbol: string; points: ResearchPoint[] }[],
) {
  const perSymbol = series.map(({ symbol, points }) => ({
    symbol,
    rebased: rebaseTo100(points),
    stats: computeStats(symbol, points),
    returns: dailyReturnsByTime(points),
  }));
  const times = Array.from(
    new Set(perSymbol.flatMap((s) => s.rebased.map((p) => p.time))),
  ).sort((a, b) => a - b);
  const lookup = perSymbol.map(
    (s) => new Map(s.rebased.map((p) => [p.time, p.value])),
  );
  const rows: ResearchRow[] = times.map((time) => {
    const row: ResearchRow = { time };
    perSymbol.forEach((s, i) => {
      row[s.symbol] = lookup[i]?.get(time) ?? null;
    });
    return row;
  });
  return {
    rows,
    stats: perSymbol.map((s) => ({
      ...s.stats,
      firstTime: s.rebased[0]?.time,
      lastTime: s.rebased.at(-1)?.time,
    })),
    correlation: {
      symbols: perSymbol.map((s) => s.symbol),
      matrix: perSymbol.map((a, i) =>
        perSymbol.map((b, j) =>
          i === j ? 1 : pearsonOnTime(a.returns, b.returns),
        ),
      ),
    },
  };
}

export function chartPresentation(input: {
  series: ChartPresentationSeries[];
  indicators: ChartPresentationIndicator[];
  rebase: boolean;
  oscillator: "none" | "rsi" | "macd";
  oscillatorSeriesId: string | null;
}) {
  const { series, indicators } = input;
  const pointsBySeries = new Map(series.map((s) => [s.id, s.points]));
  const factor = new Map(
    series.map((s) => {
      const firstClose = s.points.find(
        (p) => Number.isFinite(p.close) && (p.close as number) > 0,
      )?.close;
      return [s.id, input.rebase && firstClose != null && firstClose !== 0 ? 100 / firstClose : 1];
    }),
  );
  const times = Array.from(
    new Set(series.flatMap((s) => s.points.map((p) => p.time))),
  ).sort((a, b) => a - b);
  const byTime = new Map(
    series.map((s) => [s.id, new Map(s.points.map((p) => [p.time, p]))]),
  );
  const rows: ResearchRow[] = times.map((time) => {
    const row: ResearchRow = { time };
    for (const s of series) {
      const p = byTime.get(s.id)?.get(time);
      const f = factor.get(s.id) ?? 1;
      if (s.field === "volume") row[s.id] = p ? (p.volume as number) : null;
      else {
        row[s.id] =
          p && Number.isFinite(p.close) ? (p.close as number) * f : null;
        row[`${s.id}_o`] =
          p && Number.isFinite(p.close) ? (p.close as number) * f : null;
        row[`${s.id}_h`] =
          p && Number.isFinite(p.high) ? (p.high as number) * f : null;
        row[`${s.id}_l`] =
          p && Number.isFinite(p.low) ? (p.low as number) * f : null;
      }
    }
    return row;
  });
  for (const s of series) {
    if (s.type !== "candlestick") continue;
    let prev: number | null = null;
    for (const row of rows) {
      const close = row[s.id] ?? null;
      row[`${s.id}_o`] = prev ?? close;
      prev = close ?? prev;
    }
  }
  for (const ind of indicators) {
    const pts = pointsBySeries.get(ind.seriesId) ?? [];
    const f = factor.get(ind.seriesId) ?? 1;
    const closes = pts.map((p) =>
      Number.isFinite(p.close) ? (p.close as number) * f : NaN,
    );
    const assign = (key: string, values: (number | null)[]) => {
      const m = new Map(pts.map((p, i) => [p.time, values[i] ?? null]));
      for (const row of rows) row[key] = m.get(row.time) ?? null;
    };
    if (ind.type === "sma") assign(ind.id, sma(closes, ind.period));
    else if (ind.type === "ema") assign(ind.id, ema(closes, ind.period));
    else {
      const b = bollinger(closes, ind.period, 2);
      assign(ind.id, b.middle);
      assign(`${ind.id}_u`, b.upper);
      assign(`${ind.id}_l`, b.lower);
    }
  }
  const oscillatorRows = chartOscillatorPresentation(
    series,
    input.oscillator,
    input.oscillatorSeriesId,
  );
  return { rows, oscillatorRows };
}

export function watchlistListPresentation(
  targetPrice: number,
  currentPrice: number | null,
  addedPrice: number | null,
) {
  const distancePercent =
    currentPrice != null
      ? ((currentPrice - targetPrice) / targetPrice) * 100
      : null;
  return {
    distancePercent,
    absoluteDistancePercent:
      distancePercent == null ? null : Math.abs(distancePercent),
    isAtOrBelowTarget: currentPrice != null && currentPrice <= targetPrice,
    sinceAddedPercent:
      addedPrice != null && addedPrice > 0 && currentPrice != null
        ? ((currentPrice - addedPrice) / addedPrice) * 100
        : null,
  };
}
export function watchlistPresentation(input: {
  targetPrice: number | null;
  currentPrice: number | null;
  addedPrice: number | null;
  points: ResearchPoint[];
}) {
  const { targetPrice, currentPrice, addedPrice, points } = input;
  const hasValidTarget =
    Number.isFinite(targetPrice) && (targetPrice as number) > 0;
  const chartDistance =
    currentPrice != null && hasValidTarget
      ? ((currentPrice - (targetPrice as number)) / (targetPrice as number)) *
        100
      : null;
  const prices = points
    .map((p) => p.close)
    .filter((p): p is number => Number.isFinite(p) && (p as number) > 0);
  if (hasValidTarget) prices.push(targetPrice as number);
  const domain: [number, number] = prices.length > 0
    ? [Math.min(...prices) * 0.98, Math.max(...prices) * 1.02]
    : [0, 1];
  const preview =
    Number.isFinite(currentPrice) &&
    (currentPrice as number) > 0 &&
    hasValidTarget
      ? {
          absolutePercent:
            (targetPrice as number) < (currentPrice as number)
              ? (1 - (targetPrice as number) / (currentPrice as number)) * 100
              : ((targetPrice as number) / (currentPrice as number) - 1) * 100,
          direction:
            (targetPrice as number) < (currentPrice as number)
              ? ("below" as const)
              : ("above" as const),
        }
      : null;
  return {
    list: watchlistListPresentation(
      targetPrice as number,
      currentPrice,
      addedPrice,
    ),
    chart: {
      distancePercent: chartDistance,
      absoluteDistancePercent:
        chartDistance == null ? null : Math.abs(chartDistance),
      isAtOrBelowTarget:
        currentPrice != null &&
        hasValidTarget &&
        currentPrice <= (targetPrice as number),
      hasValidTarget,
      domain,
    },
    preview,
  };
}
export interface AnalystConsensus {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}
/** i18n keys the analyst verdict can resolve to (literal so frontends can type-check them). */
export type AnalystVerdictKey =
  | "market.strongBuy"
  | "market.buy"
  | "market.hold"
  | "market.sell"
  | "market.strongSell";
export function analystPresentation(consensus: AnalystConsensus | null) {
  const total = consensus
    ? consensus.strongBuy +
      consensus.buy +
      consensus.hold +
      consensus.sell +
      consensus.strongSell
    : 0;
  if (!consensus || total === 0) return null;
  const bullFraction = (consensus.strongBuy + consensus.buy) / total;
  const bearFraction = (consensus.sell + consensus.strongSell) / total;
  const verdictKey: AnalystVerdictKey =
    bullFraction >= 0.6
      ? "market.strongBuy"
      : bullFraction >= 0.45
        ? "market.buy"
        : bearFraction >= 0.6
          ? "market.strongSell"
          : bearFraction >= 0.45
            ? "market.sell"
            : "market.hold";
  return {
    total,
    bullFraction,
    bearFraction,
    verdictKey,
    tone:
      bullFraction >= 0.45
        ? "success"
        : bearFraction >= 0.45
          ? "destructive"
          : "warning",
    fractions: {
      strongBuy: consensus.strongBuy / total,
      buy: consensus.buy / total,
      hold: consensus.hold / total,
      sell: consensus.sell / total,
      strongSell: consensus.strongSell / total,
    },
  };
}
export function providerQuotePresentation(
  points: ResearchPoint[],
  investment: {
    symbol?: string | null | undefined;
    name: string;
    currency: string;
    priceProvider?: string | null | undefined;
  },
  selectedSymbol?: string | null,
) {
  const firstPoint = points[0];
  const lastPoint = points.at(-1);
  if (!firstPoint || !lastPoint) return null;
  // Preserve original provider-history arithmetic, including null coercion and first-zero fallback.
  const last = lastPoint.close as number;
  const first = firstPoint.close as number;
  const change = last - first;
  return {
    symbol: investment.symbol ?? selectedSymbol ?? "",
    name: investment.name,
    price: last,
    change,
    changePercent: isNonZeroNumber(first) ? (change / first) * 100 : 0,
    currency: investment.currency,
    exchange: "",
    type: (investment.priceProvider ?? "").toUpperCase(),
  };
}

export function chartOscillatorPresentation(
  series: ChartPresentationSeries[],
  oscillator: "none" | "rsi" | "macd",
  oscillatorSeriesId: string | null,
) {
  const srcId = oscillatorSeriesId ?? series[0]?.id;
  const src = series.find((s) => s.id === srcId);
  const pts = oscillator === "none" || !src ? [] : src.points;
  // Keep source's raw-close oscillator coercion separate from rebased indicators.
  const closes = pts.map((p) => p.close as number);
  const oscillatorRows: ResearchRow[] = pts.map((p) => ({ time: p.time }));
  if (oscillator === "rsi") {
    const r = rsi(closes, 14);
    oscillatorRows.forEach((row, i) => {
      row.rsi = r[i] ?? null;
    });
  } else if (oscillator === "macd") {
    const m = macd(closes);
    oscillatorRows.forEach((row, i) => {
      row.macd = m.macd[i] ?? null;
      row.signal = m.signal[i] ?? null;
      row.hist = m.histogram[i] ?? null;
    });
  }
  return oscillatorRows;
}
