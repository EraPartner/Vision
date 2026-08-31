/**
 * Alpha Vantage research adapter (ADR-079). Fallback quotes/charts.
 * Free tier: ~25 req/day — used only when higher-priority providers are tapped
 * out (it sits last in the capability chains). Key via ALPHA_VANTAGE_API_KEY.
 *
 * Methods match the capability map's alpha_vantage routes (quote/chart) and
 * return the Yahoo-adapter shapes. Shapes per the documented Alpha Vantage API —
 * needs live verification with a real key.
 */

import { z } from "zod";
import { getJson, num } from "./httpClient.js";
import { requireProviderKey } from "../providerKeys.js";
import { parseOr } from "./schemas.js";
import { makeChartRangeMap } from "@vision/types/chartRanges";

const BASE = "https://www.alphavantage.co/query";

// Envelope-only schemas (ZOD-12): the row leaves are position-numbered keys
// ('05. price', '4. close') read through num()/string munging that doubles as
// the shape check, so a leaf schema adds nothing — only the envelope guards
// are declarative.
const globalQuoteEnvelopeSchema = z.looseObject({
  "Global Quote": z.record(z.string(), z.any()).catch({}),
});

const dailySeriesEnvelopeSchema = z.looseObject({
  "Time Series (Daily)": z.record(z.string(), z.any()).catch({}),
});

const RANGE_TO_DAYS = makeChartRangeMap([
  2, 7, 31, 93, 186, 366, 731, 1827, 100000,
]);

const key = () => requireProviderKey("alpha_vantage");

// Rate-limit / info responses carry no data — surface them as errors so the
// aggregator falls through instead of caching an empty result.
/**
 * @param {unknown} payload raw JSON body — upstream shape is undocumented outside
 *   the happy path, so it is checked defensively rather than typed.
 * @returns {unknown}
 */
function assertData(payload) {
  if (payload && typeof payload === "object") {
    const p = /** @type {Record<string, unknown>} */ (payload);
    const message = p.Note || p.Information || p["Error Message"];
    if (message) throw new Error(String(message));
  }
  return payload;
}

const alphaVantageAdapter = {
  key: "alpha_vantage",

  /** @param {string} symbol */
  async quote(symbol) {
    const url = `${BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${key()}`;
    const q = parseOr(
      globalQuoteEnvelopeSchema,
      assertData(await getJson(url)),
      { "Global Quote": {} },
    )["Global Quote"];
    if (!q["05. price"]) throw new Error("alpha_vantage: no quote");
    return {
      symbol: q["01. symbol"] || symbol,
      name: symbol,
      price: num(q["05. price"]),
      change: num(q["09. change"]),
      changePercent: num((q["10. change percent"] || "").replace("%", "")),
      open: num(q["02. open"]),
      dayHigh: num(q["03. high"]),
      dayLow: num(q["04. low"]),
      prevClose: num(q["08. previous close"]),
      volume: num(q["06. volume"]),
    };
  },

  /**
   * @param {string} symbol
   * @param {{ range?: string }} [opts]
   */
  async chart(symbol, { range = "1mo" } = {}) {
    const days =
      RANGE_TO_DAYS[/** @type {keyof typeof RANGE_TO_DAYS} */ (range)] ??
      RANGE_TO_DAYS["1mo"];
    const outputsize = days > 100 ? "full" : "compact";
    const url = `${BASE}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=${outputsize}&apikey=${key()}`;
    const series = parseOr(
      dailySeriesEnvelopeSchema,
      assertData(await getJson(url)),
      { "Time Series (Daily)": {} },
    )["Time Series (Daily)"];
    const cutoff = Date.now() - days * 86_400_000;
    const points = Object.entries(series)
      .map(([date, v]) => ({
        time: Date.parse(`${date}T00:00:00Z`),
        close: num(v["4. close"]),
        high: num(v["2. high"]),
        low: num(v["3. low"]),
        volume: num(v["5. volume"]),
      }))
      .filter(
        (p) =>
          Number.isFinite(p.time) && p.time >= cutoff && p.close !== undefined,
      )
      .sort((a, b) => a.time - b.time);
    return {
      symbol,
      currency: /** @type {string | undefined} */ (undefined),
      points,
    };
  },
};

export default alphaVantageAdapter;
