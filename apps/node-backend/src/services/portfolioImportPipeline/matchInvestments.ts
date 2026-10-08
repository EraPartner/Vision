/**
 * Portfolio import pipeline — MATCH INVESTMENTS
 *
 * Resolves each validated staging row to an existing investment by symbol
 * (case-insensitive), explicit provider alias, then exact name. Unmatched rows
 * are left with a null investment and match_source — they are resolved by the user in the review
 * step (pick existing / create new). All validated rows advance to 'matched';
 * 'error'/'duplicate' rows are untouched.
 *
 * No fuzzy matching and no ISIN in this iteration (a wrong silent match would
 * corrupt cost basis).
 */

import { query } from "../../database/connection.ts";
import { logger } from "../../config/logger.ts";
import { getKinesisAssetConfig } from "../../config/kinesisConfig.ts";
import type {
  InvestmentRow,
  PortfolioImportStagingRow,
} from "../../types/rows.ts";
import type {
  PortfolioImportBatchId,
  PortfolioImportProgressCallback,
} from "./index.ts";

// Only explicit fiat quote currencies may be stripped from a Yahoo crypto
// symbol. A crypto quote or arbitrary three-letter suffix is not an alias.
const FIAT_QUOTE_CURRENCIES = new Set([
  "AED",
  "AUD",
  "BGN",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HRK",
  "HUF",
  "INR",
  "JPY",
  "KRW",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RON",
  "SAR",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "USD",
  "ZAR",
]);

/** One resolution outcome for a (symbol, name) pair. */
export type InstrumentMatch = {
  investmentId: number | null;
  matchSource: "symbol" | "name_exact" | null;
};

/** Active-investment candidates for one match key. */
type MatchCandidate = { id: number; count: number };

type MatchKeyRow = { match_key: string; id: number; count: number };

/**
 * Run the match phase: resolve each validated row to an existing investment by
 * unambiguous symbol, then provider alias, then unambiguous exact name. Cash
 * rows (brokerage deposits/withdrawals) skip resolution entirely.
 */
export async function matchBatch({
  batchId,
  onProgress,
}: {
  batchId: PortfolioImportBatchId;
  onProgress?: PortfolioImportProgressCallback;
}): Promise<{
  matchSourceCounts: Record<string, number>;
  unresolved: number;
  total: number;
}> {
  await query(
    `UPDATE portfolio_import_batches SET status = 'matching' WHERE id = $1`,
    [batchId],
  );

  // Cash rows (brokerage deposits/withdrawals) carry no instrument — advance them
  // straight to 'matched' without resolution.
  await query(
    `UPDATE portfolio_import_staging_rows
        SET status = 'matched'
      WHERE batch_id = $1 AND status = 'validated' AND route IN ('cash','account_internal')`,
    [batchId],
  );

  const { rows } = await query<
    Pick<PortfolioImportStagingRow, "id" | "symbol_raw" | "name_raw">
  >(
    `SELECT id, symbol_raw, name_raw
       FROM portfolio_import_staging_rows
      WHERE batch_id = $1 AND status = 'validated' AND (route IS NULL OR route NOT IN ('cash','account_internal'))
      ORDER BY row_index ASC`,
    [batchId],
  );

  const total = rows.length;
  if (onProgress) onProgress({ phase: "matching", current: 0, total });

  // Resolve every distinct symbol/name in a single query each rather than up to
  // two sequential SELECTs per row — brokerage exports repeat the same
  // instrument across many rows and the previous per-key loop meant one DB
  // round-trip per distinct key. Preserve the original exact-symbol priority
  // and ambiguity block before considering provider aliases or exact names.
  // A symbol with >1 active match stays unresolved without a fallback.
  const symbolMatches = await resolveBySymbolBatch(rows);

  // A provider alias is considered only when there is no exact symbol match.
  // Multiple holdings with the same alias remain unresolved, just like an
  // ambiguous exact ticker, without consulting a possibly misleading name.
  const aliasMatches = await resolveByProviderAliasBatch(rows, symbolMatches);

  // Name lookup only for rows that would reach the name path: no symbol, or a
  // symbol/alias that matched nothing (ambiguity never consults the name).
  const nameMatches = await resolveByNameBatch(
    rows,
    symbolMatches,
    aliasMatches,
  );

  // Resolve once per distinct (symbol, name) pair — brokerage exports repeat the
  // same instrument across many rows.
  const cache = new Map<string, InstrumentMatch>();
  const resolveKey = (symbol: string | null, name: string | null) =>
    `${symbol || ""}\x00${name || ""}`;

  const classify = (
    symbolRaw: string | null,
    nameRaw: string | null,
  ): InstrumentMatch => {
    const symbol = String(symbolRaw || "").trim();
    if (symbol) {
      const entry =
        symbolMatches.get(symbol.toLowerCase()) ??
        aliasMatches.get(symbol.toLowerCase());
      if (entry) {
        // Exactly one active symbol or alias candidate resolves; ambiguity
        // blocks name fallback.
        if (entry.count === 1)
          return { investmentId: entry.id, matchSource: "symbol" };
        return { investmentId: null, matchSource: null };
      }
      // Zero symbol and alias matches → fall through to the name path.
    }
    const name = String(nameRaw || "").trim();
    if (name) {
      const entry = nameMatches.get(name.toLowerCase());
      if (entry && entry.count === 1)
        return { investmentId: entry.id, matchSource: "name_exact" };
      // Ambiguous (>1) or zero name matches → unresolved.
    }
    return { investmentId: null, matchSource: null };
  };

  const ids: string[] = [];
  const investmentIds: (number | null)[] = [];
  const matchSources: (string | null)[] = [];
  const counts: Record<string, number> = {
    symbol: 0,
    name_exact: 0,
    unresolved: 0,
  };

  let seen = 0;
  for (const row of rows) {
    const key = resolveKey(row.symbol_raw, row.name_raw);
    let resolved = cache.get(key);
    if (resolved === undefined) {
      resolved = classify(row.symbol_raw, row.name_raw);
      cache.set(key, resolved);
    }
    ids.push(row.id);
    investmentIds.push(resolved.investmentId);
    matchSources.push(resolved.matchSource);
    counts[resolved.matchSource ?? "unresolved"] += 1;

    seen++;
    if (onProgress && (seen % 200 === 0 || seen === total)) {
      onProgress({ phase: "matching", current: seen, total });
    }
  }

  if (ids.length) {
    await query(
      `UPDATE portfolio_import_staging_rows s
          SET status = 'matched',
              resolved_investment_id = v.investment_id,
              match_source = v.match_source
         FROM unnest($1::bigint[], $2::int[], $3::text[])
              AS v(id, investment_id, match_source)
        WHERE s.id = v.id`,
      [ids, investmentIds, matchSources],
    );
  }

  logger.info("[portfolio-pipeline:match] done", { batchId, total, counts });
  return { matchSourceCounts: counts, unresolved: counts.unresolved, total };
}

/**
 * Resolve every distinct symbol across the batch in one query.
 *
 * Only auto-resolve on an UNAMBIGUOUS match. Two active investments sharing a
 * ticker (dual-listed, or a placeholder duplicating a real holding) must NOT
 * resolve to the lowest id — that silently corrupts the wrong holding's cost
 * basis. GROUP BY LOWER(symbol) with COUNT(*) lets the caller keep the "1 →
 * match, >1 → ambiguous/unresolved" rule; MIN(id) is the resolved id when the
 * count is 1 (identical to the old ORDER BY id LIMIT 1 on a single match).
 *
 * @returns keyed by lowercased symbol
 */
async function resolveBySymbolBatch(
  rows: { symbol_raw: string | null }[],
): Promise<Map<string, MatchCandidate>> {
  const symbols = new Set<string>();
  for (const row of rows) {
    const symbol = String(row.symbol_raw || "").trim();
    if (symbol) symbols.add(symbol.toLowerCase());
  }
  const map = new Map<string, MatchCandidate>();
  if (symbols.size === 0) return map;
  const r = await query<MatchKeyRow>(
    `SELECT LOWER(symbol) AS match_key, MIN(id) AS id, COUNT(*)::int AS count
       FROM investments
      WHERE LOWER(symbol) = ANY($1::text[]) AND is_active = true
      GROUP BY LOWER(symbol)`,
    [[...symbols]],
  );
  for (const { match_key, id, count } of r.rows) {
    map.set(String(match_key), { id, count: Number(count) });
  }
  return map;
}

/**
 * Derive an asset code only from the holding's configured price provider.
 * Kinesis codes retain their denominations: KAU/KAG never become XAU/XAG.
 */
export function providerAssetAlias(
  investment: Pick<
    InvestmentRow,
    "symbol" | "name" | "asset_class" | "price_provider" | "price_provider_id"
  >,
): string | undefined {
  const providerSymbol = String(investment.price_provider_id || "").trim();
  if (
    investment.price_provider === "yahoo" &&
    investment.asset_class === "crypto"
  ) {
    const quoteSymbol =
      providerSymbol || String(investment.symbol || "").trim();
    const pair = /^([A-Z0-9]{2,10})-([A-Z]{3})$/.exec(
      quoteSymbol.toUpperCase(),
    );
    if (pair && FIAT_QUOTE_CURRENCIES.has(pair[2]))
      return pair[1].toLowerCase();
  }
  if (investment.price_provider === "kinesis") {
    const assetName = String(investment.name || investment.symbol || "")
      .toLowerCase()
      .trim();
    const quoteSymbol =
      providerSymbol || getKinesisAssetConfig(assetName)?.symbol || "";
    const pair = /^(KAU|KAG|XAU|XAG|XPT|XPD)_(USD|EUR)$/.exec(
      quoteSymbol.toUpperCase(),
    );
    if (pair) return pair[1].toLowerCase();
  }
  return undefined;
}

/**
 * Resolve missing symbols against explicit provider-derived aliases in one
 * query. Count distinct active investment IDs, so competing quote currencies
 * or provider configurations never silently choose one holding.
 */
async function resolveByProviderAliasBatch(
  rows: { symbol_raw: string | null }[],
  symbolMatches: Map<string, MatchCandidate>,
): Promise<Map<string, MatchCandidate>> {
  const symbols = new Set<string>();
  for (const row of rows) {
    const symbol = String(row.symbol_raw || "")
      .trim()
      .toLowerCase();
    if (symbol && !symbolMatches.has(symbol)) symbols.add(symbol);
  }
  const map = new Map<string, MatchCandidate>();
  if (symbols.size === 0) return map;
  const { rows: investments } = await query<
    Pick<
      InvestmentRow,
      | "id"
      | "symbol"
      | "name"
      | "asset_class"
      | "price_provider"
      | "price_provider_id"
    >
  >(
    `SELECT id, symbol, name, asset_class, price_provider, price_provider_id
       FROM investments
      WHERE is_active = true
        AND ((price_provider = 'yahoo' AND asset_class = 'crypto') OR price_provider = 'kinesis')`,
  );
  const candidateIds = new Map<string, Set<number>>();
  for (const investment of investments) {
    const alias = providerAssetAlias(investment);
    if (!alias || !symbols.has(alias)) continue;
    let aliasIds = candidateIds.get(alias);
    if (!aliasIds) {
      aliasIds = new Set();
      candidateIds.set(alias, aliasIds);
    }
    aliasIds.add(investment.id);
  }
  for (const [alias, ids] of candidateIds) {
    // Every candidate set holds at least one id (created on first add).
    const [id] = ids;
    if (id !== undefined) map.set(alias, { id, count: ids.size });
  }
  return map;
}

/**
 * Resolve the still-unresolved remainder by exact (case- and whitespace-
 * insensitive) name in one query. Only rows whose symbol and provider alias
 * matched nothing, or that carry no symbol, reach the name path. An ambiguous
 * symbol or alias is excluded.
 *
 * @returns keyed by lowercased trimmed name
 */
async function resolveByNameBatch(
  rows: { symbol_raw: string | null; name_raw: string | null }[],
  symbolMatches: Map<string, MatchCandidate>,
  aliasMatches: Map<string, MatchCandidate>,
): Promise<Map<string, MatchCandidate>> {
  const names = new Set<string>();
  for (const row of rows) {
    const symbol = String(row.symbol_raw || "").trim();
    // Skip rows resolved or blocked by an exact symbol or provider alias.
    if (
      symbol &&
      (symbolMatches.has(symbol.toLowerCase()) ||
        aliasMatches.has(symbol.toLowerCase()))
    )
      continue;
    const name = String(row.name_raw || "").trim();
    if (name) names.add(name.toLowerCase());
  }
  const map = new Map<string, MatchCandidate>();
  if (names.size === 0) return map;
  const r = await query<MatchKeyRow>(
    `SELECT LOWER(TRIM(name)) AS match_key, MIN(id) AS id, COUNT(*)::int AS count
       FROM investments
      WHERE LOWER(TRIM(name)) = ANY($1::text[]) AND is_active = true
      GROUP BY LOWER(TRIM(name))`,
    [[...names]],
  );
  for (const { match_key, id, count } of r.rows) {
    map.set(String(match_key), { id, count: Number(count) });
  }
  return map;
}
