/**
 * Market Lookup routes — thin HTTP handlers over marketLookupService (ADR-067
 * route → service boundary). Each handler parses/validates the request and
 * delegates; the cache, coalescing, Yahoo client, and quote assembly all live
 * in services/marketLookupService.js.
 */

import { Router } from "express";
import { z } from "zod";
import { ValidationError } from "../middleware/errorHandler.ts";
import { parseInput } from "../lib/zodInput.ts";
import {
  getChart,
  getNews,
  getQuotes,
  searchSymbols,
} from "../services/marketLookupService.ts";

const router = Router();

/** Test-only re-export: clear the per-symbol quote cache between cases. */
export { __clearQuoteCacheForTests } from "../services/marketLookupService.ts";

/**
 * A comma-separated symbol list. Express parses a repeated key
 * (`?symbols=A&symbols=B`) as an array; joining keeps that form working.
 */
const symbolListSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) =>
    Array.isArray(value) ? value.join(",") : (value ?? ""),
  );

/** yahoo-finance2's chart interval vocabulary; anything else fails upstream. */
const CHART_INTERVALS = [
  "1m",
  "2m",
  "5m",
  "15m",
  "30m",
  "60m",
  "90m",
  "1h",
  "1d",
  "5d",
  "1wk",
  "1mo",
  "3mo",
] as const;

const searchQuerySchema = z.object({ q: z.string().optional() });

const quoteQuerySchema = z.object({
  symbols: symbolListSchema,
  detail: z.string().optional(),
});

const chartQuerySchema = z.object({
  symbol: z.string().optional(),
  // Unknown ranges fall back to one month in the service.
  range: z.string().optional(),
  interval: z.enum(CHART_INTERVALS).optional(),
});

const newsQuerySchema = z.object({
  symbols: symbolListSchema,
  count: z.string().optional(),
});

// GET /api/market/search?q=apple
router.get("/search", async (req, res) => {
  const { q } = parseInput(searchQuerySchema, req.query);
  if (!q) return res.ok({ items: [] });

  res.ok(await searchSymbols(q));
});

// GET /api/market/quote?symbols=AAPL,MSFT[&detail=basic]
// `detail=basic` returns price fields only; the default (full) additionally
// fetches quoteSummary for fundamentals/analyst data. Results are per-symbol
// cached and concurrent identical fetches are coalesced (see the service).
router.get("/quote", async (req, res) => {
  const { symbols, detail } = parseInput(quoteQuerySchema, req.query);
  if (!symbols) throw new ValidationError("symbols parameter required");
  const basic = detail?.trim() === "basic";

  const symbolList = symbols
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  res.ok(await getQuotes(symbolList, basic));
});

// GET /api/market/chart?symbol=AAPL&range=1mo&interval=1d
router.get("/chart", async (req, res) => {
  const { symbol, range, interval } = parseInput(chartQuerySchema, req.query);
  if (!symbol) throw new ValidationError("symbol parameter required");

  res.ok(await getChart(symbol, { range, interval }));
});

// GET /api/market/news?symbols=AAPL,MSFT&count=20
router.get("/news", async (req, res) => {
  const { symbols, count } = parseInput(newsQuerySchema, req.query);

  res.ok(await getNews(symbols, count || "20"));
});

export default router;
