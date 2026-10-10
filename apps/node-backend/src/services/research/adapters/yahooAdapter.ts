/**
 * Yahoo research adapter (ADR-079).
 *
 * Wraps yahoo-finance2 behind the research adapter shape: one method per data
 * type (search / quote / chart / fundamentals / analyst / news). Needs no API
 * key, so it is always usable and serves as the baseline provider the others
 * light up alongside as keys are provisioned.
 *
 * Each method returns normalized data or throws — the aggregator records the
 * error and falls through to the next provider in the capability chain.
 *
 * NO_VALIDATE: yahoo-finance2 validates every upstream payload and throws on any
 * schema drift; Yahoo's responses drift and vary by IP/geo. We read a small
 * subset of known fields, so we opt out of the throw and degrade to whatever
 * came back — matching services/marketLookupService.js.
 */

import {
  getYahooClient,
  NO_VALIDATE,
  parseYahooPayload,
  requireYahooPayload,
  yahooChartResultSchema,
  yahooDateMs,
  yahooQuoteSchema,
  yahooQuoteSummarySchema,
  yahooSearchResultSchema,
} from "../../prices/yahooClient.ts";
import type {
  YahooChartInterval,
  YahooQuoteSummary,
} from "../../prices/yahooClient.ts";
import { makeChartRangeMap } from "@vision/types/chartRanges";

/** `Number.isFinite` as a type guard (same semantics: false for non-numbers). */
function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

const RANGE_TO_PERIOD1 = makeChartRangeMap([
  () => new Date(Date.now() - 1 * 86_400_000),
  () => new Date(Date.now() - 5 * 86_400_000),
  () => monthsAgo(1),
  () => monthsAgo(3),
  () => monthsAgo(6),
  () => yearsAgo(1),
  () => yearsAgo(2),
  () => yearsAgo(5),
  () => new Date("1970-01-01"),
]);

function monthsAgo(n: number) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() - n, d.getDate());
}

function yearsAgo(n: number) {
  const d = new Date();
  return new Date(d.getFullYear() - n, d.getMonth(), d.getDate());
}

function rangeToDate(range: string) {
  return (
    RANGE_TO_PERIOD1[range as keyof typeof RANGE_TO_PERIOD1] ??
    RANGE_TO_PERIOD1["1mo"]
  )();
}

function normalizeThumbnailUrl(url: unknown) {
  if (!url || typeof url !== "string") return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("http://")) return `https://${trimmed.slice(7)}`;
  if (trimmed.startsWith("https://")) return trimmed;
  return undefined;
}

/** The `url` of one raw thumbnail resolution entry, if it is an object. */
function resolutionUrl(entry: unknown): unknown {
  return entry && typeof entry === "object" && "url" in entry
    ? entry.url
    : undefined;
}

/**
 * @param thumbnail raw yahoo-finance2 payload (NO_VALIDATE — see file header).
 */
function pickBestThumbnail(thumbnail: unknown) {
  const raw =
    thumbnail && typeof thumbnail === "object" && "resolutions" in thumbnail
      ? thumbnail.resolutions
      : undefined;
  const resolutions: readonly unknown[] = Array.isArray(raw) ? raw : [];
  for (let i = resolutions.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeThumbnailUrl(resolutionUrl(resolutions[i]));
    if (candidate) return candidate;
  }
  return undefined;
}

const yahooAdapter = {
  key: "yahoo",

  async search(query: string) {
    const yahoo = await getYahooClient();
    const results = requireYahooPayload(
      yahooSearchResultSchema,
      await yahoo.search(query, { quotesCount: 8, newsCount: 0 }, NO_VALIDATE),
      "search",
    );
    const items = (results.quotes || [])
      .filter((r) => r.symbol)
      .map((r) => ({
        symbol: r.symbol,
        name: r.shortname || r.longname || r.symbol,
        type: r.quoteType || "UNKNOWN",
        exchange: r.exchDisp || r.exchange || "",
      }));
    return { items };
  },

  async quote(symbol: string) {
    const yahoo = await getYahooClient();
    const q = requireYahooPayload(
      yahooQuoteSchema,
      await yahoo.quote(symbol, {}, NO_VALIDATE),
      "quote",
    );
    return {
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent,
      currency: q.currency || "USD",
      exchange: q.fullExchangeName || q.exchange,
      type: q.quoteType,
      open: q.regularMarketOpen,
      dayHigh: q.regularMarketDayHigh,
      dayLow: q.regularMarketDayLow,
      prevClose: q.regularMarketPreviousClose,
      volume: q.regularMarketVolume,
      avgVolume: q.averageDailyVolume3Month,
      high52w: q.fiftyTwoWeekHigh,
      low52w: q.fiftyTwoWeekLow,
    };
  },

  async chart(
    symbol: string,
    {
      range = "1mo",
      interval = "1d",
    }: { range?: string; interval?: YahooChartInterval } = {},
  ) {
    const yahoo = await getYahooClient();
    const result = parseYahooPayload(
      yahooChartResultSchema,
      await yahoo.chart(
        symbol,
        {
          period1: rangeToDate(range),
          interval,
          includePrePost: false,
        },
        NO_VALIDATE,
      ),
    );
    const points = (result?.quotes || [])
      .filter((p) => p.close != null)
      .map((p) => ({
        time: yahooDateMs(p.date),
        close: p.close,
        high: p.high,
        low: p.low,
        volume: p.volume,
      }));
    return {
      symbol: result?.meta?.symbol ?? symbol,
      currency: result?.meta?.currency,
      points,
    };
  },

  async fundamentals(symbol: string) {
    const yahoo = await getYahooClient();
    const s: YahooQuoteSummary | undefined = parseYahooPayload(
      yahooQuoteSummarySchema,
      await yahoo.quoteSummary(
        symbol,
        {
          modules: [
            "summaryDetail",
            "defaultKeyStatistics",
            "price",
            "financialData",
            "assetProfile",
          ],
        },
        NO_VALIDATE,
      ),
    );
    const sd = s?.summaryDetail || {};
    const ks = s?.defaultKeyStatistics || {};
    const pr = s?.price || {};
    const fd = s?.financialData || {};
    const ap = s?.assetProfile || {};
    const marketCap = sd.marketCap ?? pr.marketCap;
    const freeCashFlow = fd.freeCashflow;
    const fcfYield =
      isFiniteNumber(freeCashFlow) && isFiniteNumber(marketCap) && marketCap > 0
        ? freeCashFlow / marketCap
        : undefined;
    return {
      symbol,
      name: pr.longName || pr.shortName || symbol,
      currency: pr.currency,
      sector: ap.sector,
      marketCap,
      pe: sd.trailingPE ?? ks.trailingPE,
      forwardPE: sd.forwardPE ?? ks.forwardPE,
      pegRatio: ks.pegRatio,
      dividendYield: sd.dividendYield ?? pr.dividendYield,
      payoutRatio: sd.payoutRatio,
      eps: pr.epsTrailingTwelveMonths ?? ks.trailingEps,
      beta: sd.beta ?? ks.beta,
      priceToBook: ks.priceToBook,
      profitMargin: fd.profitMargins,
      grossMargin: fd.grossMargins,
      operatingMargin: fd.operatingMargins,
      revenue: fd.totalRevenue,
      revenueGrowth: fd.revenueGrowth,
      earningsGrowth: fd.earningsGrowth,
      returnOnEquity: fd.returnOnEquity,
      // Yahoo reports debt/equity as a percentage (150 = 1.5×); normalize to a ratio.
      debtToEquity: isFiniteNumber(fd.debtToEquity)
        ? fd.debtToEquity / 100
        : undefined,
      currentRatio: fd.currentRatio,
      quickRatio: fd.quickRatio,
      freeCashFlow,
      fcfYield,
    };
  },

  async analyst(symbol: string) {
    const yahoo = await getYahooClient();
    const s: YahooQuoteSummary | undefined = parseYahooPayload(
      yahooQuoteSummarySchema,
      await yahoo.quoteSummary(
        symbol,
        {
          modules: [
            "recommendationTrend",
            "upgradeDowngradeHistory",
            "financialData",
          ],
        },
        NO_VALIDATE,
      ),
    );
    const trendBuckets = s?.recommendationTrend?.trend || [];
    const current =
      trendBuckets.find((t) => t.period === "0m") || trendBuckets[0];
    const consensus = current
      ? {
          strongBuy: current.strongBuy ?? 0,
          buy: current.buy ?? 0,
          hold: current.hold ?? 0,
          sell: current.sell ?? 0,
          strongSell: current.strongSell ?? 0,
        }
      : undefined;
    const fd = s?.financialData || {};
    const recentActions = (s?.upgradeDowngradeHistory?.history || [])
      .slice(0, 10)
      .map((h) => ({
        date: h.epochGradeDate,
        firm: h.firm,
        toGrade: h.toGrade,
        fromGrade: h.fromGrade || undefined,
        action: h.action,
      }));
    return {
      symbol,
      consensus,
      targetMean: fd.targetMeanPrice,
      targetHigh: fd.targetHighPrice,
      targetLow: fd.targetLowPrice,
      numberOfAnalysts: fd.numberOfAnalystOpinions,
      recentActions,
    };
  },

  async news(symbol: string, { count = 20 }: { count?: number } = {}) {
    const yahoo = await getYahooClient();
    const newsCount = Math.min(count, 50);
    const results = requireYahooPayload(
      yahooSearchResultSchema,
      await yahoo.search(symbol, { quotesCount: 0, newsCount }, NO_VALIDATE),
      "search",
    );
    const articles = (results.news || []).map((n) => ({
      title: n.title,
      link: n.link,
      publisher: n.publisher,
      publishedAt: n.providerPublishTime
        ? new Date(n.providerPublishTime).getTime()
        : undefined,
      thumbnail: pickBestThumbnail(n.thumbnail),
      relatedSymbols: [symbol],
    }));
    return { articles };
  },
};

export default yahooAdapter;
