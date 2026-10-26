/**
 * Currency Conversion Service
 *
 * Converts currencies to EUR using ECB exchange rates.
 *
 * Design:
 * - Fetches latest rates from ECB (primary) on startup and every 12 hours
 * - Supplements ECB rates with open.er-api.com for currencies ECB doesn't cover
 *   (AED, SAR, KWD, QAR, BHD, OMR, PKR, EGP, NGN, and ~130 more)
 * - ECB always takes priority over the supplementary source on overlapping currencies
 * - If both APIs are unavailable the service uses the stored rates; a currency
 *   without a stored rate has no rate (callers flag it), never a constant
 */

import { sql } from "kysely";
import { checkedRows, db } from "../../database/db.ts";
import { RowContractError } from "../../database/rowContracts.ts";
import {
  currencyDatePairRowSchema,
  currencyDayKeyRowSchema,
  historicalRateRowSchema,
  latestStoredRateRowSchema,
} from "../../database/rows/portfolio.ts";
import type { LatestStoredRateDbRow } from "../../database/rows/portfolio.ts";
import { logger } from "../../config/logger.ts";
import { toDecimal, toNumber } from "../../lib/money.ts";
import type { DecimalInput } from "../../lib/money.ts";
import {
  recordSuccess as recordProviderSuccess,
  recordError as recordProviderError,
} from "../providerHealthService.ts";
import {
  CACHE_LIFETIME_MS,
  normalizeDateInput,
  fetchFromEcb,
  fetchFromErApi,
  fetchHistoricalFromEcbFull,
  rateOnOrBeforeFromMap,
  loadFromDatabase,
  saveToDatabase,
  saveHistoricalRate,
  getUnindexedRatesToEurForDates,
  buildHistoricalRateIndex,
  findRateOnOrBeforeInIndex,
  getRateToEurForDate,
  clearHistoricalCache,
} from "./rateFetcher.ts";
import { settingsRepository } from "../../repositories/settingsRepository.ts";
import type { HistoricalRateIndex, RateTable } from "../../types/rows.ts";
import { stringifyCell } from "../cellText.ts";

/** Every stored rate of the given currencies, with calendar-day dates. */
function selectHistoricalRates(currencies: readonly string[]) {
  return db
    .selectFrom("exchange_rates")
    .select([
      "currency_code",
      sql<string>`to_char(rate_date, 'YYYY-MM-DD')`.as("rate_date"),
      "rate_to_eur",
    ])
    .where("currency_code", "=", sql<string>`ANY(${currencies}::text[])`);
}

/** Message of a caught value, for log metadata. */
function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

// In-memory cache: { rates: {...}, timestamp: number } | null
let memoryCache: { rates: RateTable; timestamp: number } | null = null;

// Process-level cache of the built historical-rate index. Historical-FX row
// conversion (convertRowsToEur, dataFetcherTax) otherwise reloaded the full
// exchange_rates history and rebuilt the index on EVERY request. The index is
// built for a growing union of requested currencies so a request with a new
// currency set doesn't invalidate it; it's invalidated whenever rates are
// refreshed (warmCache), the memory cache is cleared, or a backfill runs, and
// expires after CACHE_LIFETIME_MS as a backstop. Cache misses still resolve
// correctly via the per-date fallback paths, so conversion results are unchanged.
let historicalIndexCache: {
  index: HistoricalRateIndex;
  currencies: string[];
  builtAt: number;
} | null = null;

// Rate table when nothing is stored yet: only the EUR base, so every other
// currency reads as unavailable.
const NO_STORED_RATES: RateTable = Object.freeze({ EUR: 1 });

// ─── Cache helpers ────────────────────────────────────────────────────────────

/**
 * Get current rates using the cache hierarchy:
 *   1. In-memory cache (24-hour TTL)
 *   2. Database (latest stored rows)
 * With no stored rates the table holds only EUR: other currencies have no
 * rate, which callers flag and leave out, never convert at a constant or 1:1.
 */
async function getRates(): Promise<RateTable> {
  if (memoryCache && Date.now() - memoryCache.timestamp < CACHE_LIFETIME_MS) {
    return memoryCache.rates;
  }

  const dbRates = await loadFromDatabase();
  if (dbRates) {
    memoryCache = { rates: dbRates, timestamp: Date.now() };
    return dbRates;
  }

  logger.warn("No stored exchange rates — only EUR amounts can be converted");
  // Return the reference (callers never mutate) so warmCache can detect that
  // nothing is stored via identity comparison.
  return NO_STORED_RATES;
}

/**
 * Clear in-memory cache to force fresh data on next request.
 */
export function clearMemoryCache() {
  memoryCache = null;
  clearHistoricalCache();
  clearHistoricalIndexCache();
  logger.debug("Cleared exchange rate memory cache");
}

/** Drop the cached historical-rate index (rebuilt on next demand). */
function clearHistoricalIndexCache() {
  historicalIndexCache = null;
}

/**
 * Historical-rate index for the given currencies, cached at process level and
 * shared across call sites. Builds (or extends) the index for the union of
 * already-cached and newly-requested currencies so distinct currency sets don't
 * thrash the cache. A superset index is safe: per-currency lookups
 * (findRateOnOrBeforeInIndex) is unaffected by extra
 * currencies being present.
 */
export async function getHistoricalRateIndex(
  currencies: string[],
): Promise<HistoricalRateIndex> {
  const wanted = [...new Set(currencies)].filter(Boolean);
  if (wanted.length === 0) return new Map();

  const cache = historicalIndexCache;
  const fresh =
    cache !== null && Date.now() - cache.builtAt < CACHE_LIFETIME_MS;
  if (fresh && wanted.every((c) => cache.currencies.includes(c))) {
    return cache.index;
  }

  const union = fresh ? [...new Set([...cache.currencies, ...wanted])] : wanted;
  const rows = await checkedRows(
    historicalRateRowSchema,
    selectHistoricalRates(union)
      .orderBy("currency_code", "asc")
      .orderBy("rate_date", "asc"),
  );
  const index = buildHistoricalRateIndex(rows);
  historicalIndexCache = { index, currencies: union, builtAt: Date.now() };
  return index;
}

/**
 * Merge fetched points into the request's historical index without duplicating
 * dates. If another request replaced the process cache while providers were in
 * flight, invalidate that newer-but-now-stale cache so the next request reloads
 * the points just persisted to PostgreSQL.
 */
function mergeFetchedRatesIntoHistoricalIndex(
  requestIndex: HistoricalRateIndex,
  fetchedRates: Map<string, number>,
) {
  for (const [key, rate] of fetchedRates) {
    const separator = key.indexOf(":");
    const currency = key.slice(0, separator);
    const date = key.slice(separator + 1);
    const byDate = new Map(
      (requestIndex.get(currency) ?? []).map((point) => [
        point.date,
        point.rate,
      ]),
    );
    byDate.set(date, rate);
    requestIndex.set(
      currency,
      [...byDate].map(([pointDate, pointRate]) => ({
        date: pointDate,
        rate: pointRate,
      })),
    );
  }
  for (const entries of requestIndex.values()) {
    entries.sort((left, right) => left.date.localeCompare(right.date));
  }

  if (
    historicalIndexCache !== null &&
    historicalIndexCache.index !== requestIndex
  ) {
    clearHistoricalIndexCache();
  }
}

/**
 * Latest stored exchange-rate rows (`is_latest = true`), one per currency,
 * ordered by currency code, as `{ rows }` like the raw pg result it used to
 * return — the /exchange-rates route owns response shaping (ADR-067: routes
 * call services, never the database layer directly).
 */
export async function listLatestStoredRates(): Promise<{
  rows: LatestStoredRateDbRow[];
}> {
  const rows = await checkedRows(
    latestStoredRateRowSchema,
    db
      .selectFrom("exchange_rates")
      .select(["currency_code", "rate_to_eur", "rate_date", "fetched_at"])
      .where("is_latest", "=", true)
      .orderBy("currency_code", "asc"),
  );
  return { rows };
}

/**
 * Fetch fresh rates from both sources, update the DB and the memory cache.
 * ECB is fetched first and takes priority; open.er-api fills in currencies ECB doesn't publish.
 * Called on startup and every 12 hours by the scheduler in main.ts.
 */
export async function warmCache() {
  try {
    const [ecbRates, erarRates] = await Promise.all([
      fetchFromEcb(),
      fetchFromErApi(),
    ]);

    if (ecbRates) {
      void recordProviderSuccess("ecb");
    } else {
      void recordProviderError("ecb", "ECB fetch returned no rates");
    }

    if (erarRates) {
      void recordProviderSuccess("open.er-api");
    } else {
      void recordProviderError(
        "open.er-api",
        "open.er-api fetch returned no rates",
      );
    }

    if (!ecbRates && !erarRates) {
      const rates = await getRates();
      logger.warn(
        rates === NO_STORED_RATES
          ? "No exchange rates available (all APIs unavailable, none stored)"
          : "Exchange rate cache warmed from database (all APIs unavailable)",
      );
      return;
    }

    // Supplementary first, then ECB overwrites any overlaps
    const freshRates: RateTable = {
      ...(erarRates ?? {}),
      ...(ecbRates ?? {}),
    };

    const ecbCount = ecbRates ? Object.keys(ecbRates).length - 1 : 0;
    const totalCount = Object.keys(freshRates).length - 1;
    // Supplementary = er-api currencies that survived the ECB-priority merge,
    // i.e. total minus ECB (not erarCount − ecbCount, which miscounted when
    // the two sources didn't fully overlap).
    logger.info(
      `Merged exchange rates: ${ecbCount} from ECB + ${totalCount - ecbCount} supplementary = ${totalCount} total`,
    );

    // Partial provider success must retain known rates for omitted currencies.
    // Only provider quotes may be stamped with today's date in the database.
    const storedRates = await loadFromDatabase();
    const mergedRates = {
      ...(storedRates ?? {}),
      ...(memoryCache?.rates ?? {}),
      ...freshRates,
    };
    await saveToDatabase(freshRates);
    memoryCache = { rates: mergedRates, timestamp: Date.now() };
    // Fresh rates were written — drop the cached historical index so the 12h
    // refresh cycle is the primary invalidation hook for it.
    clearHistoricalIndexCache();
  } catch (err) {
    // A contract violation is a data fault, not a transient failure: surface it.
    if (err instanceof RowContractError) throw err;
    logger.warn("Failed to warm exchange rate cache", {
      error: errorMessage(err),
    });
  }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

export interface ConvertRowsOptions {
  useHistoricalRatesByDate?: boolean;
  /** Column holding the row's date; falls back to the well-known date columns. */
  dateField?: string | null;
}

/**
 * Fields {@link convertRowsToEur} adds to each row. `amount_eur` is undefined
 * when no stored rate converts the row (ADR-216): callers leave such a row out
 * of a total and count it, never add its native amount 1:1.
 */
export type ConversionFields = {
  amount_eur: number | undefined;
  used_fallback_rate?: boolean;
  fallback_reason?: string;
};

/** A date column value {@link normalizeDateInput} understands. */
type DateColumn = string | Date | null | undefined;

/**
 * The columns {@link convertRowsToEur} reads. Rows are arbitrary query
 * projections: every other column passes through to the result untouched.
 */
export interface ConvertibleRow {
  amount?: DecimalInput;
  currency?: string | null;
  date?: DateColumn;
  day?: DateColumn;
  transaction_date?: DateColumn;
  planned_date?: DateColumn;
  rate_date?: DateColumn;
}

/** A row returned by {@link convertRowsToEur}: the input row plus the conversion fields. */
export type ConvertedRow<T extends ConvertibleRow = ConvertibleRow> = T &
  ConversionFields;

/**
 * Narrow a `dateField` column (named at runtime, so untyped) to a date input.
 * A value of another type is stringified, exactly as
 * {@link normalizeDateInput} itself would.
 */
function toDateColumn(value: unknown): DateColumn {
  if (value === null || value === undefined || value instanceof Date) {
    return value;
  }
  if (typeof value === "string") return value;
  // Other primitives stringify as normalizeDateInput would; an object's default
  // stringification ("[object Object]") never matches a date, so it maps to null.
  return typeof value === "object" || typeof value === "function"
    ? null
    : stringifyCell(value);
}

/**
 * Convert an array of rows to a target currency (default EUR).
 * Rows must have `amount` and `currency` fields.
 * Returns rows with an `amount_eur` field containing the converted amount, or
 * undefined when no stored rate (historical or latest) exists for the source or
 * the target currency.
 *
 * Rows are arbitrary query projections (any column may be the date — see
 * `dateField`); each result row keeps the caller's own row type.
 */
export async function convertRowsToEur<T extends ConvertibleRow>(
  rows: readonly T[] | null | undefined,
  targetCurrency = "EUR",
  options: ConvertRowsOptions | null = {},
): Promise<ConvertedRow<T>[]> {
  if (rows == null || rows.length === 0) return [];

  const { useHistoricalRatesByDate = false, dateField = null } = options ?? {};
  const toCur = (targetCurrency || "EUR").toUpperCase().trim();
  const rates = await getRates();

  /** @returns 'YYYY-MM-DD', or null when the row carries no usable date */
  function resolveDateFromRow(row: T): string | null {
    // Any column may be the date; read it through an untyped view of the row.
    const fieldValue: unknown = dateField
      ? (row as Readonly<Record<string, unknown>>)[dateField]
      : undefined;
    if (fieldValue) return normalizeDateInput(toDateColumn(fieldValue));
    const firstDate = [
      row.date,
      row.day,
      row.transaction_date,
      row.planned_date,
    ].find((value) => value != null && value !== "");
    return normalizeDateInput(firstDate ?? row.rate_date);
  }

  // Resolve a rate for one side of the conversion. Returns the rate plus a
  // boolean flagging whether we fell back to current rates because the
  // requested historical rate was missing. convertRowsToEur retains this as
  // internal row metadata. Recipient pivot summarizes it into an explicit
  // response-level conversion contract; other repositories may project it away.
  function resolveRateWithFallback(
    code: string,
    rowDate: string | null,
  ): { rate: number | undefined; fellBack: boolean } {
    if (code === "EUR") return { rate: 1, fellBack: false };

    if (!useHistoricalRatesByDate || !rowDate) {
      return { rate: rates[code], fellBack: false };
    }

    const historical = historicalIndex
      ? findRateOnOrBeforeInIndex(historicalIndex, code, rowDate)
      : undefined;
    if (historical !== undefined) return { rate: historical, fellBack: false };

    const fallback = rates[code];
    if (fallback !== undefined) {
      logger.warn("Historical FX missing, falling back to current rate", {
        currency: code,
        date: rowDate,
      });
      return { rate: fallback, fellBack: true };
    }
    // No rate found anywhere — retain the same internal diagnostic flag.
    return { rate: undefined, fellBack: true };
  }

  // Each row's date is resolved once and reused by both passes below.
  const rowDates: Array<string | null> = [];
  function rowDateAt(index: number, row: T): string | null {
    let rowDate = rowDates[index];
    if (rowDate === undefined) {
      rowDate = resolveDateFromRow(row);
      rowDates[index] = rowDate;
    }
    return rowDate;
  }

  let historicalIndex: HistoricalRateIndex | null = null;
  if (useHistoricalRatesByDate) {
    const relevantCurrencies = [
      ...new Set([
        ...rows.map((row) => (row.currency || "EUR").toUpperCase().trim()),
        toCur,
      ]),
    ].filter(Boolean);

    if (relevantCurrencies.length > 0) {
      historicalIndex = await getHistoricalRateIndex(relevantCurrencies);

      const datesByUnindexedCurrency = new Map<string, string[]>();
      for (const [index, row] of rows.entries()) {
        const rowDate = rowDateAt(index, row);
        if (!rowDate) continue;
        const rowCurrency = (row.currency || "EUR").toUpperCase().trim();
        if (rowCurrency === toCur) continue;
        for (const currency of [rowCurrency, toCur]) {
          if (
            currency === "EUR" ||
            findRateOnOrBeforeInIndex(historicalIndex, currency, rowDate) !==
              undefined
          )
            continue;
          const pending = datesByUnindexedCurrency.get(currency);
          if (pending) pending.push(rowDate);
          else datesByUnindexedCurrency.set(currency, [rowDate]);
        }
      }

      const fetchedRates = await getUnindexedRatesToEurForDates(
        datesByUnindexedCurrency,
      );
      mergeFetchedRatesIntoHistoricalIndex(historicalIndex, fetchedRates);
    }
  }

  const converted: ConvertedRow<T>[] = [];
  for (const [index, row] of rows.entries()) {
    const currency = (row.currency || "EUR").toUpperCase().trim();
    // A number survives the Decimal round trip unchanged, so skip it.
    const amount =
      typeof row.amount === "number"
        ? row.amount
        : toNumber(toDecimal(row.amount));
    const rowDate = rowDateAt(index, row);

    if (currency === toCur) {
      converted.push({ ...row, amount_eur: amount });
      continue;
    }

    const fromResolved = resolveRateWithFallback(currency, rowDate);
    const toResolved = resolveRateWithFallback(toCur, rowDate);
    const fellBack = fromResolved.fellBack || toResolved.fellBack;
    const fallbackFields = fellBack
      ? { used_fallback_rate: true, fallback_reason: "historical_rate_missing" }
      : {};

    if (
      fromResolved.rate == null ||
      fromResolved.rate === 0 ||
      toResolved.rate == null ||
      toResolved.rate === 0
    ) {
      logger.warn("No stored exchange rate, row left unconverted", {
        from: currency,
        to: toCur,
      });
      converted.push({ ...row, amount_eur: undefined, ...fallbackFields });
      continue;
    }
    converted.push({
      ...row,
      // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
      amount_eur: (amount * fromResolved.rate) / toResolved.rate,
      ...fallbackFields,
    });
  }

  return converted;
}

/**
 * Generic converter from any currency to any currency at the latest stored
 * rates.
 *
 * @param fromCurrency falsy short-circuits to `amount`
 * @param toCurrency defaults to EUR when falsy
 * @returns undefined when either currency has no stored rate
 */
export async function convertToCurrency(
  amount: number,
  fromCurrency: string | null | undefined,
  toCurrency: string | null | undefined,
): Promise<number | undefined> {
  if (
    !fromCurrency ||
    fromCurrency.toUpperCase().trim() ===
      (toCurrency || "EUR").toUpperCase().trim()
  ) {
    return amount;
  }
  const rates = await getRates();
  return convertWithRates(amount, fromCurrency, toCurrency, rates);
}

/**
 * Fetch the current rate table once. Callers that convert many rows in a loop
 * should call this once and pass the result to {@link convertWithRates},
 * avoiding a per-row `await` on the (already memory-cached) rate lookup.
 */
export async function loadCurrentRates(): Promise<RateTable> {
  return getRates();
}

/**
 * Synchronous conversion against a pre-fetched rate table. Mirrors the logic of
 * {@link convertToCurrency} exactly — only the rate acquisition is hoisted out.
 *
 * @param fromCurrency falsy short-circuits to `amount`
 * @param toCurrency defaults to EUR when falsy
 * @returns undefined when the table has no rate for either currency; callers
 *   leave the amount out of a total and flag it, never add it 1:1
 */
export function convertWithRates(
  amount: number,
  fromCurrency: string | null | undefined,
  toCurrency: string | null | undefined,
  rates: RateTable,
): number | undefined {
  if (
    !fromCurrency ||
    fromCurrency.toUpperCase().trim() ===
      (toCurrency || "EUR").toUpperCase().trim()
  ) {
    return amount;
  }

  const from = fromCurrency.toUpperCase().trim();
  const to = (toCurrency || "EUR").toUpperCase().trim();

  const rateFrom = rates[from];
  const rateTo = rates[to];

  if (rateFrom == null || rateFrom === 0 || rateTo == null || rateTo === 0) {
    logger.warn("No stored exchange rate, amount left unconverted", {
      from,
      to,
    });
    return undefined;
  }

  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  return (amount * rateFrom) / rateTo;
}

// ─── Historical backfill ──────────────────────────────────────────────────────

// One-time repair marker: before the full-history tier existed, the backfill
// saved nearest-known rates under old transaction dates (fabricated history).
// The repair overwrites those rows with true ECB rates; the flag is only set
// once the full-history download succeeded so offline starts retry later.
const FX_FULL_HISTORY_REPAIR_FLAG = "fx_full_history_repair_done";

/**
 * Overwrite stored txn-date rates with true ECB full-history values (one-time).
 *
 * @param pairs distinct non-EUR (currency, date) pairs
 * @returns rows repaired, or undefined when the repair could not run (offline)
 */
async function repairHistoricalRatesFromFullHistory(
  pairs: Array<{ currency_code: string; rate_date: string | Date }>,
): Promise<number | undefined> {
  if ((await settingsRepository.get(FX_FULL_HISTORY_REPAIR_FLAG)) === true)
    return 0;

  const fullByDate = await fetchHistoricalFromEcbFull();
  if (fullByDate.size === 0) return undefined;

  const currencies = [
    ...new Set(
      pairs.map((p) =>
        (p.currency_code || "")
          .toUpperCase()
          .trim(),
      ),
    ),
  ].filter(Boolean);
  const storedRows = await checkedRows(
    historicalRateRowSchema,
    selectHistoricalRates(currencies),
  );
  const storedByKey = new Map(
    storedRows.map((r) => [
      `${r.currency_code}:${r.rate_date}`,
      toNumber(toDecimal(r.rate_to_eur)),
    ]),
  );

  let repaired = 0;
  for (const pair of pairs) {
    const code = (pair.currency_code || "")
      .toUpperCase()
      .trim();
    const dateStr = normalizeDateInput(pair.rate_date);
    if (!code || !dateStr) continue;

    const truth = rateOnOrBeforeFromMap(fullByDate, code, dateStr);
    if (truth === undefined) continue; // currency not published by ECB

    const stored = storedByKey.get(`${code}:${dateStr}`);
    if (
      stored !== undefined &&
      Math.abs(stored - truth) <= Math.abs(truth) * 1e-9
    )
      continue;

    await saveHistoricalRate(code, dateStr, truth);
    repaired += 1;
  }

  await settingsRepository.set(FX_FULL_HISTORY_REPAIR_FLAG, true);
  return repaired;
}

/**
 * Stamp `fx_rate_to_eur` onto manual non-EUR transactions that lack it, using the
 * stored rate on-or-before the transaction date (≤ 7 days back — the standard
 * weekend/holiday convention). Distant nearest rates are never stamped; those
 * rows stay NULL and read paths keep resolving them per-date with a fallback flag.
 * Source-provenance rows keep their booked FX evidence and immutable receipts;
 * their missing historical rates are still backfilled in exchange_rates.
 */
async function stampTransactionFxRates() {
  const result = await sql`UPDATE portfolio_transactions pt
     SET fx_rate_to_eur = sub.rate
     FROM (
       SELECT pt2.id,
              (SELECT er.rate_to_eur
               FROM exchange_rates er
               WHERE er.currency_code = UPPER(pt2.currency::text)
                 AND er.rate_date <= pt2.date::date
                 AND er.rate_date >= pt2.date::date - INTERVAL '7 days'
               ORDER BY er.rate_date DESC
               LIMIT 1) AS rate
       FROM portfolio_transactions pt2
       WHERE pt2.fx_rate_to_eur IS NULL
         AND pt2.import_batch_id IS NULL
         AND pt2.source_record_hash IS NULL
         AND pt2.dedup_fingerprint IS NULL
         AND pt2.currency IS NOT NULL
         AND UPPER(pt2.currency::text) <> 'EUR'
     ) sub
     WHERE pt.id = sub.id AND sub.rate IS NOT NULL
       AND pt.fx_rate_to_eur IS NULL
       AND pt.import_batch_id IS NULL
       AND pt.source_record_hash IS NULL
       AND pt.dedup_fingerprint IS NULL`.execute(db);
  return Number(result.numAffectedRows ?? 0n);
}

export async function backfillPortfolioHistoricalRates() {
  const pairRows = await checkedRows(
    currencyDatePairRowSchema,
    sql`SELECT pt.currency::text AS currency_code, pt.date::date AS rate_date
     FROM portfolio_transactions pt
     WHERE pt.currency IS NOT NULL
       AND UPPER(pt.currency::text) <> 'EUR'
     GROUP BY pt.currency::text, pt.date::date
     ORDER BY pt.date::date ASC`,
  );
  if (pairRows.length === 0)
    return { inserted: 0, missing: 0, repaired: 0, stamped: 0 };

  let repaired = 0;
  try {
    repaired = (await repairHistoricalRatesFromFullHistory(pairRows)) ?? 0;
  } catch (err) {
    // A contract violation is a data fault, not a transient failure: surface it.
    if (err instanceof RowContractError) throw err;
    logger.warn("Full-history FX repair failed — will retry next startup", {
      error: errorMessage(err),
    });
  }

  const missingRows = await checkedRows(
    currencyDatePairRowSchema,
    sql`SELECT pt.currency::text AS currency_code, pt.date::date AS rate_date
     FROM portfolio_transactions pt
     LEFT JOIN exchange_rates er
       ON er.currency_code = UPPER(pt.currency::text)
      AND er.rate_date = pt.date::date
     WHERE pt.currency IS NOT NULL
       AND UPPER(pt.currency::text) <> 'EUR'
       AND er.id IS NULL
     GROUP BY pt.currency::text, pt.date::date
     ORDER BY pt.date::date ASC`,
  );

  let inserted = 0;
  let unresolved = 0;

  const resolvedPairs: Array<{ currencyCode: string; rateDate: string }> = [];
  for (const row of missingRows) {
    const currencyCode = (row.currency_code || "")
      .toUpperCase()
      .trim();
    const rateDate = normalizeDateInput(row.rate_date);
    if (!currencyCode || !rateDate) continue;

    // getRateToEurForDate persists rates it sources from ECB (90d or full
    // history). When it falls through to a prior stored rate no exact row
    // appears — count those as unresolved rather than fabricating history.
    await getRateToEurForDate(currencyCode, rateDate, {
      saveFetchedHistoricalRate: true,
    });
    resolvedPairs.push({ currencyCode, rateDate });
  }

  // One batched existence check for every attempted pair, replacing the former
  // per-row SELECT (the N+1). Same accounting: a pair with an exact stored row
  // now counts as inserted, everything else unresolved.
  if (resolvedPairs.length > 0) {
    const codes = resolvedPairs.map((p) => p.currencyCode);
    const dates = resolvedPairs.map((p) => p.rateDate);
    const existsRows = await checkedRows(
      currencyDayKeyRowSchema,
      sql`SELECT er.currency_code, er.rate_date::text AS rate_date
         FROM exchange_rates er
         JOIN UNNEST(${codes}::text[], ${dates}::text[]) AS want(currency_code, rate_date)
           ON er.currency_code = want.currency_code
          AND er.rate_date = want.rate_date::date`,
    );
    const present = new Set(
      existsRows.map(
        (r) => `${r.currency_code}|${r.rate_date.slice(0, 10)}`,
      ),
    );
    for (const p of resolvedPairs) {
      if (present.has(`${p.currencyCode}|${p.rateDate}`)) inserted += 1;
      else unresolved += 1;
    }
  }

  let stamped = 0;
  try {
    stamped = await stampTransactionFxRates();
  } catch (err) {
    logger.warn("Stamping fx_rate_to_eur onto transactions failed", {
      error: errorMessage(err),
    });
  }

  if (inserted > 0 || unresolved > 0 || repaired > 0 || stamped > 0) {
    logger.info("Portfolio historical FX backfill complete", {
      inserted,
      unresolved,
      repaired,
      stamped,
    });
  }

  if (inserted > 0 || repaired > 0) {
    clearHistoricalCache();
    clearHistoricalIndexCache();
  }

  return { inserted, missing: unresolved, repaired, stamped };
}

export default {
  convertRowsToEur,
  convertToCurrency,
  convertWithRates,
  loadCurrentRates,
  listLatestStoredRates,
  warmCache,
  clearMemoryCache,
  backfillPortfolioHistoricalRates,
};

export { clearHistoricalIndexCache as __clearHistoricalIndexCache };
