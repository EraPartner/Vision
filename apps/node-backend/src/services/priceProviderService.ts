/**
 * Price Provider Service — thin orchestrator
 *
 * Delegates to:
 *   - prices/priceCache.js — in-memory TTL cache + DB persistence
 *   - prices/priceProviderRegistry.js — provider strategies (Binance, Yahoo, custom, Kinesis)
 */

import { logger } from "../config/logger.ts";
import { UpstreamError } from "../middleware/errorHandler.ts";
import { assertPublicHttpUrl } from "../lib/urlSafety.ts";
import { epochMsToUtcYmd } from "../lib/dateFormat.ts";
import {
  recordSuccess as recordProviderSuccess,
  recordError as recordProviderError,
} from "./providerHealthService.ts";
import { convertRowsToEur } from "./currency/currencyConversionService.ts";
import {
  cacheGet,
  cacheSet,
  loadHistoricalPointsFromDatabase,
  loadLatestHistoricalPointByInvestmentIds,
  normalizeHistoryPoints,
  filterPointsByRange,
  needsHistoryRefresh,
  countChangedPointPrices,
  toNumber,
  isValidPrice,
} from "./prices/priceCache.ts";
import {
  PROVIDERS,
  resolveYahooSymbol,
  resolveCustomHistoryConfig,
  resolveKinesisConfig,
  sanitizeKinesisIsolatedSpikes,
  parseCustomHistoryPoints,
} from "./prices/priceProviderRegistry.ts";
import { getYahooClient } from "./prices/yahooClient.ts";

import type { InvestmentRow, PricePoint } from "../types/rows.ts";
import type { LivePriceQuote } from "./prices/priceProviderRegistry.ts";

export type { InvestmentRow, PricePoint, LivePriceQuote };

/** One `chart().quotes` entry of the untyped Yahoo client response. */
interface YahooChartQuote {
  date?: string | number | Date | null;
  close?: unknown;
}

/**
 * The provider configuration `fetchHistoricalPrices` reads: an investment row
 * or a narrower projection of its provider columns.
 */
export type HistoricalPriceInvestment = Pick<InvestmentRow, "id"> &
  Partial<InvestmentRow>;

/**
 * A resolved live-price result for one investment. `source` reflects which
 * tier of the fetch → cache → cached-price → historical-fallback chain
 * produced it: a `LivePriceQuote.source` value ('live'|'close') when it came
 * straight off a provider/cache hit, or 'cached'/'historical_fallback' for
 * the two degraded tiers below.
 */
export interface ResolvedPrice {
  price: number;
  source: string;
  /** only set for 'historical_fallback'. */
  stale_as_of_ms?: number | null;
}

export {
  saveHistoricalPointsToDatabase,
  resetPriceCache as __resetPriceCache,
} from "./prices/priceCache.ts";

export { getHistoricalPriceAt } from "./prices/priceProviderRegistry.ts";

export const SUPPORTED_PROVIDERS = [
  { key: "manual", name: "Manual", description: "Set price manually" },
  {
    key: "binance",
    name: "Binance",
    description:
      'Free crypto prices (use symbol, e.g. "BTCUSDT", "ETHUSDT", "BNBEUR")',
  },
  {
    key: "yahoo",
    name: "Yahoo Finance",
    description:
      'Stocks, ETFs & metals (use ticker, e.g. "AAPL", "VWCE.DE", "GC=F")',
  },
  {
    key: "custom",
    name: "Custom JSON",
    description: "Any JSON endpoint with a configurable price path",
  },
  {
    key: "kinesis",
    name: "Kinesis",
    description:
      'Precious metals & commodities (use symbol, e.g. "KAU_USD", "XAU_USD", "XAG_USD")',
  },
];

// ─── Live price fetching ──────────────────────────────────────────────────────

async function fetchLivePrices(
  investments: InvestmentRow[],
): Promise<Record<number, number>> {
  const detailed = await fetchLivePricesDetailed(investments);
  return Object.fromEntries(
    Object.entries(detailed).map(([id, data]) => [id, data.price]),
  );
}

/**
 * @param opts.cachedPricesByInvestmentId stored prices, coerced with toNumber
 */
export async function fetchLivePricesDetailed(
  investments: InvestmentRow[],
  {
    cachedPricesByInvestmentId = {},
  }: { cachedPricesByInvestmentId?: Record<number, unknown> } = {},
): Promise<Record<number, ResolvedPrice>> {
  const results: Record<number, ResolvedPrice> = {};
  const stale: Record<string, InvestmentRow[]> = {
    binance: [],
    yahoo: [],
    custom: [],
    kinesis: [],
  };

  for (const inv of investments) {
    const provider = inv.price_provider || "manual";
    if (provider === "manual") continue;

    const providerKey =
      provider === "yahoo"
        ? resolveYahooSymbol(inv)
        : inv.price_provider_id || "";
    if (!providerKey && provider !== "custom" && provider !== "kinesis")
      continue;

    const cacheKey =
      provider === "custom" || provider === "kinesis"
        ? `${provider}:${inv.id}`
        : `${provider}:${providerKey}`;

    const cached = cacheGet(cacheKey);
    const cachedPrice = toNumber(cached?.price ?? cached);
    if (isValidPrice(cachedPrice)) {
      results[inv.id] = {
        price: cachedPrice,
        source: cached?.source || "live",
      };
    } else if (stale[provider]) {
      stale[provider].push(inv);
    }
  }

  // Provider fetch tasks. Two shapes (SIMP-33): id-based providers batch by a
  // resolved symbol and key results/cache by that symbol; investment-based
  // providers pass the investments through and key by inv.id.
  const runProviderTask = async (
    key: string,
    label: string,
    task: () => Promise<void>,
  ): Promise<void> => {
    try {
      await task();
      recordProviderSuccess(key);
    } catch (err) {
      logger.error(`${label} failed`, { error: (err as Error).message });
      recordProviderError(key, err);
    }
  };

  // { key, resolveId, batchFn, label }
  const idBasedProviders: {
    key: string;
    resolveId: (inv: InvestmentRow) => string;
    batchFn: (ids: string[]) => Promise<Record<string, LivePriceQuote>>;
    label: string;
  }[] = [
    {
      key: "binance",
      resolveId: (inv) => (inv.price_provider_id || "").toUpperCase(),
      batchFn: PROVIDERS.binance,
      label: "Binance batch fetch",
    },
    {
      key: "yahoo",
      resolveId: resolveYahooSymbol,
      batchFn: PROVIDERS.yahoo,
      label: "Yahoo Finance batch fetch",
    },
  ];
  // { key, batchFn, label } — kinesis already converts EUR-symbol prices out of USD.
  const investmentBasedProviders: {
    key: string;
    batchFn: (
      investments: InvestmentRow[],
    ) => Promise<Record<string, LivePriceQuote>>;
    label: string;
  }[] = [
    { key: "custom", batchFn: PROVIDERS.custom, label: "Custom price fetch" },
    {
      key: "kinesis",
      batchFn: PROVIDERS.kinesis,
      label: "Kinesis price fetch",
    },
  ];

  const providerTasks: Promise<void>[] = [];

  for (const { key, resolveId, batchFn, label } of idBasedProviders) {
    if (!stale[key].length) continue;
    providerTasks.push(
      runProviderTask(key, label, async () => {
        const ids = [...new Set(stale[key].map(resolveId).filter(Boolean))];
        const prices = await batchFn(ids);
        for (const inv of stale[key]) {
          const pid = resolveId(inv);
          if (prices[pid]) {
            results[inv.id] = {
              price: prices[pid].price,
              source: prices[pid].source || "live",
            };
            cacheSet(`${key}:${pid}`, {
              price: prices[pid].price,
              source: prices[pid].source || "live",
            });
          }
        }
      }),
    );
  }

  for (const { key, batchFn, label } of investmentBasedProviders) {
    if (!stale[key].length) continue;
    providerTasks.push(
      runProviderTask(key, label, async () => {
        const prices = await batchFn(stale[key]);
        for (const inv of stale[key]) {
          const data = prices[inv.id];
          if (data !== undefined && isValidPrice(data.price)) {
            results[inv.id] = { price: data.price, source: "live" };
            cacheSet(`${key}:${inv.id}`, { price: data.price, source: "live" });
          }
        }
      }),
    );
  }

  if (providerTasks.length > 0) {
    await Promise.allSettled(providerTasks);
  }

  for (const inv of investments) {
    if (results[inv.id] !== undefined) continue;
    const cachedPrice = toNumber(cachedPricesByInvestmentId[inv.id]);
    if (isValidPrice(cachedPrice)) {
      results[inv.id] = { price: cachedPrice, source: "cached" };
    }
  }

  // Final offline-safety fallback: pull the most recent persisted historical
  // price from `asset_price_history`. Prevents portfolio valuations from
  // silently dropping investments when both the live provider and the
  // in-memory/DB-warm caches are unavailable (e.g. machine offline).
  const fallbackIds = investments
    .filter(
      (inv) =>
        results[inv.id] === undefined &&
        (inv.price_provider || "manual") !== "manual",
    )
    .map((inv) => inv.id);

  if (fallbackIds.length > 0) {
    try {
      const latestByInvestment =
        await loadLatestHistoricalPointByInvestmentIds(fallbackIds);
      for (const invId of fallbackIds) {
        const last = latestByInvestment.get(invId);
        if (!last) continue;
        const price = toNumber(last.price);
        if (isValidPrice(price)) {
          results[invId] = {
            price,
            source: "historical_fallback",
            stale_as_of_ms: Number.isFinite(last.timestampMs)
              ? last.timestampMs
              : null,
          };
        }
      }
    } catch (err) {
      logger.warn("Historical price fallback failed", {
        error: (err as Error).message,
      });
    }
  }

  return results;
}

// ─── Historical price fetching ────────────────────────────────────────────────

const BINANCE_DAY_MS = 24 * 60 * 60 * 1000;
const BINANCE_PAGE_LIMIT = 1000;
const BINANCE_MAX_PAGES = 30; // 30 × 1000 daily candles ≈ 82 years — a runaway guard, not a real bound

function _dayKey(ms: number): number {
  return Math.floor(Number(ms) / BINANCE_DAY_MS);
}

/**
 * Fetch daily Binance klines across an arbitrary window, paginating past the 1000-row
 * per-request limit via startTime/endTime. Returns the raw kline rows (caller maps/normalizes).
 */
async function _fetchBinanceKlines(
  binanceSymbol: string,
  startMs: number,
  endMs: number,
): Promise<(number | string)[][]> {
  const collected: (number | string)[][] = [];
  let cursor = Number(startMs);
  const end = Number(endMs);

  for (let page = 0; page < BINANCE_MAX_PAGES; page += 1) {
    const url =
      "https://data-api.binance.vision/api/v3/klines" +
      `?symbol=${encodeURIComponent(binanceSymbol)}` +
      `&interval=1d&startTime=${cursor}&endTime=${end}&limit=${BINANCE_PAGE_LIMIT}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new UpstreamError(`Binance API error: ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return collected;

    collected.push(...data);
    if (data.length < BINANCE_PAGE_LIMIT) return collected;

    const lastOpen = Number(data[data.length - 1][0]);
    if (!Number.isFinite(lastOpen)) return collected;
    const next = lastOpen + BINANCE_DAY_MS;
    if (next > end) return collected;
    cursor = next;
  }

  logger.warn(
    `Binance history pagination hit page cap (${BINANCE_MAX_PAGES}) for ${binanceSymbol}; series may be truncated`,
  );
  return collected;
}

function _filterHistoricalPoints(
  points: PricePoint[],
  fromMs?: number,
  toMs?: number,
): PricePoint[] {
  return filterPointsByRange(points, { fromMs, toMs });
}

async function _persistAndResolve(
  investmentId: number,
  points: PricePoint[],
  source: string,
  cachedDbPoints: PricePoint[],
  { fromMs, toMs }: { fromMs?: number; toMs?: number } = {},
) {
  const { saveHistoricalPointsToDatabase } =
    await import("./prices/priceCache.ts");
  // Only persist points within the requested range — providers (Yahoo, Binance, Kinesis)
  // return data beyond the window bounds, which would otherwise accumulate and be deleted
  // by cleanupStaleQuotes on every restart.
  const pointsInRange = _filterHistoricalPoints(points, fromMs, toMs);
  await saveHistoricalPointsToDatabase(investmentId, pointsInRange, source);
  const persisted = await loadHistoricalPointsFromDatabase(investmentId, {
    fromMs,
    toMs,
  });
  const resolved =
    persisted.length > 0
      ? persisted
      : normalizeHistoryPoints([
          ...(cachedDbPoints || []),
          ...(pointsInRange || []),
        ]);
  return _filterHistoricalPoints(resolved, fromMs, toMs);
}

/**
 * @param opts.force bypass DB endpoint coverage and the provider memory cache to re-query the provider.
 *   needsHistoryRefresh only inspects the series' first/last point vs the window bounds, so a
 *   sparse-but-endpoint-spanning series would otherwise never be re-fetched. The gap-fill /
 *   densify paths set force to repopulate interior gaps.
 */
export async function fetchHistoricalPrices(
  investment: HistoricalPriceInvestment | null | undefined,
  {
    fromMs,
    toMs,
    dbOnly = false,
    force = false,
  }: {
    fromMs?: number;
    toMs?: number;
    dbOnly?: boolean | string | number;
    force?: boolean;
  } = {},
): Promise<PricePoint[]> {
  if (!investment) return [];
  const provider = investment.price_provider || "manual";
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : undefined;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : undefined;
  const dbOnlyMode =
    dbOnly === true || dbOnly === "true" || dbOnly === 1 || dbOnly === "1";

  const cachedDbPoints = await loadHistoricalPointsFromDatabase(investment.id, {
    fromMs: from,
    toMs: to,
  });

  if (dbOnlyMode) {
    if (provider === "kinesis") {
      return _filterHistoricalPoints(
        sanitizeKinesisIsolatedSpikes(cachedDbPoints),
        from,
        to,
      );
    }
    return _filterHistoricalPoints(cachedDbPoints, from, to);
  }

  if (
    !force &&
    !needsHistoryRefresh(cachedDbPoints, { fromMs: from, toMs: to })
  ) {
    if (provider === "kinesis") {
      const sanitized = sanitizeKinesisIsolatedSpikes(cachedDbPoints);
      const changed = countChangedPointPrices(cachedDbPoints, sanitized);
      if (changed > 0) {
        const { saveHistoricalPointsToDatabase } =
          await import("./prices/priceCache.ts");
        await saveHistoricalPointsToDatabase(
          investment.id,
          sanitized,
          "kinesis",
        );
      }
      return _filterHistoricalPoints(sanitized, from, to);
    }
    return _filterHistoricalPoints(cachedDbPoints, from, to);
  }

  if (provider === "yahoo") {
    const symbol = resolveYahooSymbol(investment);
    if (!symbol) return [];

    const now = Date.now();
    const startDay = _dayKey(from ?? now - 5 * 365 * BINANCE_DAY_MS);
    const endDay = _dayKey(to ?? now);
    const cacheKey = `yahoo-history:${symbol}:${startDay}:${endDay}`;
    const cached = force ? undefined : cacheGet(cacheKey);
    let points: PricePoint[] | undefined = Array.isArray(cached?.points)
      ? cached.points
      : undefined;

    if (!points) {
      try {
        const yahooFinance = await getYahooClient();
        const chart = await yahooFinance.chart(symbol, {
          period1: new Date(startDay * BINANCE_DAY_MS),
          // Yahoo's end is exclusive; include the requested final calendar day.
          period2: new Date((endDay + 1) * BINANCE_DAY_MS),
          interval: "1d",
          includePrePost: false,
        });

        points = normalizeHistoryPoints(
          ((chart?.quotes || []) as YahooChartQuote[])
            .map((q) => ({
              timestampMs: q?.date ? new Date(q.date).getTime() : Number.NaN,
              price: toNumber(q?.close),
            }))
            .filter(
              (p) => Number.isFinite(p.timestampMs) && isValidPrice(p.price),
            ),
        );

        cacheSet(cacheKey, { points, source: "live" });
      } catch (err) {
        logger.warn(
          `Yahoo history fetch error for ${symbol}: ${(err as Error).message}`,
        );
        return _filterHistoricalPoints(cachedDbPoints, from, to);
      }
    }

    return _persistAndResolve(investment.id, points, "yahoo", cachedDbPoints, {
      fromMs: from,
      toMs: to,
    });
  }

  if (provider === "binance") {
    const symbol = (investment.price_provider_id || "").trim().toUpperCase();
    if (!symbol) return [];

    const KNOWN_QUOTE_SUFFIXES = ["EUR", "USDT", "USDC", "BUSD", "BTC", "ETH"];
    const hasKnownQuote = KNOWN_QUOTE_SUFFIXES.some((suffix) =>
      symbol.endsWith(suffix),
    );
    const binanceSymbol = hasKnownQuote ? symbol : `${symbol}USDT`;

    // Walk the full window in daily candles. Binance klines return at most 1000 rows per
    // request, so paginate via startTime/endTime instead of the old limit=min(days,365) cap,
    // which silently dropped every point older than a year.
    const startMs =
      from !== undefined ? from : Date.now() - 365 * BINANCE_DAY_MS;
    const endMs = to !== undefined ? to : Date.now();
    const cacheKey = `binance-history:${symbol}:${_dayKey(startMs)}:${_dayKey(endMs)}`;
    const cached = force ? undefined : cacheGet(cacheKey);
    let points: PricePoint[] | undefined = Array.isArray(cached?.points)
      ? cached.points
      : undefined;

    if (!points) {
      try {
        const klines = await _fetchBinanceKlines(binanceSymbol, startMs, endMs);
        points = normalizeHistoryPoints(
          klines
            .map((kline) => ({
              timestampMs: Number(kline[0]),
              price: toNumber(kline[4]),
            }))
            .filter(
              (p) => Number.isFinite(p.timestampMs) && isValidPrice(p.price),
            ),
        );

        cacheSet(cacheKey, { points, source: "live" });
      } catch (err) {
        logger.warn(
          `Binance history fetch error for ${symbol}: ${(err as Error).message}`,
        );
        return _filterHistoricalPoints(cachedDbPoints, from, to);
      }
    }

    return _persistAndResolve(
      investment.id,
      points,
      "binance",
      cachedDbPoints,
      { fromMs: from, toMs: to },
    );
  }

  if (provider === "kinesis") {
    const { symbol, timeframe, fromDate, needsUsdToEur } =
      resolveKinesisConfig(investment);

    if (!symbol) {
      logger.warn(
        `Kinesis history: no symbol configured for investment ${investment.id}`,
      );
      return _filterHistoricalPoints(cachedDbPoints, from, to);
    }

    const cacheKey = `kinesis-history:${symbol}:${timeframe}`;
    const cached = force ? undefined : cacheGet(cacheKey);
    let points: PricePoint[] | undefined = Array.isArray(cached?.points)
      ? cached.points
      : undefined;

    if (!points) {
      try {
        const url = `${(await import("../config/kinesisConfig.ts")).KINESIS_BASE_URL}?symbolIds=${encodeURIComponent(symbol)}&timeFrame=${timeframe}&fromDate=${fromDate}`;
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          logger.warn(`Kinesis history API error: ${res.status} for ${symbol}`);
          return _filterHistoricalPoints(cachedDbPoints, from, to);
        }

        const data = (await res.json()) as Record<string, unknown> | null;
        const rawPoints = data?.[symbol];
        if (!Array.isArray(rawPoints)) {
          logger.warn(`Kinesis history: invalid data for ${symbol}`);
          return _filterHistoricalPoints(cachedDbPoints, from, to);
        }

        const { _parseKinesisTrendlinePoints } =
          await import("./prices/priceProviderRegistry.ts");
        points = _parseKinesisTrendlinePoints(rawPoints);
        cacheSet(cacheKey, { points, source: "live" });
      } catch (err) {
        logger.warn(
          `Kinesis history fetch error for ${symbol}: ${(err as Error).message}`,
        );
        return _filterHistoricalPoints(cachedDbPoints, from, to);
      }
    }

    // Kinesis serves USD only. For a non-USD investment, convert the fetched
    // series to the investment's currency at each point's *historical* FX rate
    // before it's persisted as this asset's price history. convertRowsToEur
    // bulk-loads the rate index in one query — no per-date round-trips.
    // Applied outside the cache block so a shared USD cache entry is converted
    // per-investment.
    const invCurrency = (investment.currency || "EUR").toUpperCase();
    if (
      needsUsdToEur &&
      invCurrency !== "USD" &&
      Array.isArray(points) &&
      points.length > 0
    ) {
      const rows = points.map((p) => ({
        amount: p.price,
        currency: "USD",
        date: epochMsToUtcYmd(p.timestampMs),
      }));
      const converted = await convertRowsToEur(rows, invCurrency, {
        useHistoricalRatesByDate: true,
        dateField: "date",
      });
      points = points.map((p, i) => ({ ...p, price: converted[i].amount_eur }));
    }

    return _persistAndResolve(
      investment.id,
      points,
      "kinesis",
      cachedDbPoints,
      { fromMs: from, toMs: to },
    );
  }

  if (provider !== "custom") {
    return _filterHistoricalPoints(cachedDbPoints, from, to);
  }

  const config = resolveCustomHistoryConfig(investment);
  if (!config.historyUrl) return [];

  const cacheKey = `custom-history:${investment.id}:${config.historyUrl}:${config.historyPath}:${config.timestampPath}:${config.pricePath}`;
  const cached = force ? undefined : cacheGet(cacheKey);
  let points: PricePoint[] | undefined = Array.isArray(cached?.points)
    ? cached.points
    : undefined;

  if (!points) {
    try {
      // SSRF guard: config.historyUrl is a user-controlled custom-provider URL,
      // so validate it (DNS-resolved private/loopback/non-http block) and follow
      // redirects manually, re-checking every hop — mirrors the guarded "latest"
      // path in priceProviderRegistry._fetchJson so a public host cannot 302 the
      // request onto an internal address.
      let url = String(config.historyUrl);
      let res: Response;
      for (let hop = 0; ; hop += 1) {
        await assertPublicHttpUrl(url);
        res = await fetch(url, {
          headers: { Accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        const location =
          res.status >= 300 && res.status < 400
            ? res.headers.get("location")
            : undefined;
        if (!location) break;
        if (hop >= 3) throw new UpstreamError("too many redirects");
        url = new URL(location, url).toString();
      }
      if (!res.ok) throw new UpstreamError(`HTTP ${res.status}`);
      const data = await res.json();
      points = normalizeHistoryPoints(parseCustomHistoryPoints(data, config));
      cacheSet(cacheKey, { points, source: "live" });
    } catch (err) {
      logger.warn(
        `Custom history fetch error for investment ${investment.id}: ${(err as Error).message}`,
      );
      return _filterHistoricalPoints(cachedDbPoints, from, to);
    }
  }

  return _persistAndResolve(investment.id, points, "custom", cachedDbPoints, {
    fromMs: from,
    toMs: to,
  });
}

// ─── Kinesis DB sanitization ──────────────────────────────────────────────────

export async function sanitizePersistedKinesisHistory() {
  const investmentsResult = await (
    await import("../database/connection.ts")
  ).query<{
    id: number;
  }>(`SELECT id FROM investments WHERE price_provider = 'kinesis'`, []);

  const investments = investmentsResult.rows || [];
  if (investments.length === 0) {
    logger.info("Kinesis history sanitization skipped: no kinesis investments");
    return { processed: 0, updated: 0, correctedPoints: 0, failed: 0 };
  }

  const { saveHistoricalPointsToDatabase } =
    await import("./prices/priceCache.ts");
  let updated = 0;
  let correctedPoints = 0;
  let failed = 0;

  for (const investment of investments) {
    try {
      const points = await loadHistoricalPointsFromDatabase(investment.id);
      if (!Array.isArray(points) || points.length < 3) continue;

      const sanitized = sanitizeKinesisIsolatedSpikes(points);
      const changed = countChangedPointPrices(points, sanitized);
      if (changed > 0) {
        await saveHistoricalPointsToDatabase(
          investment.id,
          sanitized,
          "kinesis",
        );
        updated += 1;
        correctedPoints += changed;
      }
    } catch (error) {
      failed += 1;
      logger.warn("Kinesis history sanitization failed for investment", {
        investmentId: investment.id,
        error: (error as Error | null | undefined)?.message,
      });
    }
  }

  const sanitizationStats = {
    processed: investments.length,
    updated,
    correctedPoints,
    failed,
  };
  if (correctedPoints > 0 || failed > 0) {
    logger.info("Kinesis history sanitization complete", sanitizationStats);
  } else {
    logger.debug("Kinesis history sanitization complete", sanitizationStats);
  }

  return { processed: investments.length, updated, correctedPoints, failed };
}

export { fetchLivePrices as __fetchLivePrices };
