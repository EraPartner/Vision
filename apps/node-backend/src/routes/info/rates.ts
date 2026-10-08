/**
 * FX + inflation rate endpoints:
 *   - GET  /exchange-rates
 *   - POST /exchange-rates/refresh
 *   - GET  /inflation-rates
 *   - POST /inflation-rates/refresh
 */

import { Router } from "express";
import { logger } from "../../config/logger.ts";
import { rateLimiter, adminRateLimiter } from "../../middleware/rateLimiter.ts";
import {
  FALLBACK_RATES,
  warmCache,
  clearMemoryCache,
  listLatestStoredRates,
} from "../../services/currency/currencyConversionService.ts";
import {
  getInflationRates,
  clearInflationMemoryCache,
} from "../../services/belgianInflationService.ts";
import { toDecimal, toNumber } from "../../lib/money.ts";
import { formatDateToYmd } from "../../lib/dateFormat.ts";
import { getMonthParam, getCurrentDateString } from "./_queryParams.ts";
import { parseBooleanQueryParam } from "../../lib/httpParams.ts";

// The pg row shape for `exchange_rates` as SELECTed above — NUMERIC columns
// arrive as strings (see toDecimal/toNumber below), DATE as a Date at local
// midnight (verified against alembic/versions' exchange_rates definition).
interface ExchangeRateRow {
  currency_code: string;
  rate_to_eur: string;
  rate_date: Date;
  fetched_at: Date;
}

const router = Router();

router.get(
  "/exchange-rates",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "exchange-rates",
  }),
  async (req, res) => {
    const dbOnly = parseBooleanQueryParam(req.query.db_only);

    const result = await listLatestStoredRates();

    const rows = result.rows as ExchangeRateRow[];
    const rates = rows.map((row) => ({
      currency: row.currency_code,
      rate_to_eur: toNumber(toDecimal(row.rate_to_eur)),
      rate_date:
        row.rate_date instanceof Date
          ? formatDateToYmd(row.rate_date)
          : String(row.rate_date),
      fetched_at: row.fetched_at,
    }));

    const today = getCurrentDateString();
    const storedDate = rates.length > 0 ? rates[0].rate_date : null;
    const isStale = !storedDate || storedDate < today;
    const lastFetchedAt = rates.reduce((latest: number, row) => {
      const ts = row.fetched_at ? new Date(row.fetched_at).getTime() : NaN;
      return Number.isFinite(ts) && ts > latest ? ts : latest;
    }, 0);
    const source = rates.length > 0 ? "database" : "fallback";

    if (isStale && !dbOnly) {
      clearMemoryCache();
      warmCache().catch((err) =>
        logger.warn("Background exchange rate refresh failed", {
          error: err.message,
        }),
      );
    }

    res.ok({
      total_rates: rates.length,
      rates,
      fallback_rates: FALLBACK_RATES || {},
      source,
      is_stale: isStale,
      last_fetched_at:
        lastFetchedAt > 0 ? new Date(lastFetchedAt).toISOString() : null,
    });
  },
);

router.post("/exchange-rates/refresh", adminRateLimiter, async (req, res) => {
  clearMemoryCache();
  await warmCache();
  res.ok({ message: "Exchange rates refreshed from ECB" });
});

router.get(
  "/inflation-rates",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "inflation-rates",
  }),
  async (req, res) => {
    const startMonth = getMonthParam(req.query.start_month);
    const endMonth = getMonthParam(req.query.end_month);
    // Default to DB-only so the request never blocks on a slow/unreachable
    // Statbel/Eurostat fetch when the host is offline. Background refresh is
    // scheduled so cached data is updated whenever connectivity returns.
    // Clients can opt in to a synchronous live fetch with ?db_only=false.
    const dbOnly = parseBooleanQueryParam(req.query.db_only, true);
    const result = await getInflationRates({
      startMonth,
      endMonth,
      dbOnly,
      scheduleBackgroundRefresh: dbOnly,
    });

    res.ok({
      source: result.source,
      total_rates: result.rates.length,
      rates: result.rates,
    });
  },
);

router.post("/inflation-rates/refresh", adminRateLimiter, async (req, res) => {
  clearInflationMemoryCache();
  const result = await getInflationRates({ forceRefresh: true });
  res.ok({
    message: "Belgian inflation rates refreshed from Statbel",
    source: result.source,
    total_rates: result.rates.length,
  });
});

export default router;
