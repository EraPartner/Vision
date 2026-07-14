/**
 * Portfolio import pipeline — MATCH INVESTMENTS
 *
 * Resolves each validated staging row to an existing investment by symbol
 * (case-insensitive) then exact name. Unmatched rows are left with a null
 * investment and match_source — they are resolved by the user in the review
 * step (pick existing / create new). All validated rows advance to 'matched';
 * 'error'/'duplicate' rows are untouched.
 *
 * No fuzzy matching and no ISIN in this iteration (a wrong silent match would
 * corrupt cost basis).
 */

import { query } from '../../database/connection.js';
import { logger } from '../../config/logger.js';

export async function matchBatch({ batchId, onProgress }) {
  await query(`UPDATE portfolio_import_batches SET status = 'matching' WHERE id = $1`, [batchId]);

  // Cash rows (brokerage deposits/withdrawals) carry no instrument — advance them
  // straight to 'matched' without resolution.
  await query(
    `UPDATE portfolio_import_staging_rows
        SET status = 'matched'
      WHERE batch_id = $1 AND status = 'validated' AND route = 'cash'`,
    [batchId],
  );

  const { rows } = await query(
    `SELECT id, symbol_raw, name_raw
       FROM portfolio_import_staging_rows
      WHERE batch_id = $1 AND status = 'validated' AND (route IS DISTINCT FROM 'cash')
      ORDER BY row_index ASC`,
    [batchId],
  );

  const total = rows.length;
  if (onProgress) onProgress({ phase: 'matching', current: 0, total });

  // Resolve every distinct symbol/name in a single query each rather than up to
  // two sequential SELECTs per row — brokerage exports repeat the same
  // instrument across many rows and the previous per-key loop meant one DB
  // round-trip per distinct key. The batched maps below reproduce the exact
  // per-row semantics of the old resolveInvestment: unambiguous symbol first,
  // then (only when the symbol has zero matches) unambiguous exact name, else
  // unresolved. A symbol with >1 active match stays ambiguous → unresolved and
  // never falls through to name matching (matching the old early return).
  const symbolMatches = await resolveBySymbolBatch(rows);

  // Name lookup only for rows that would reach the name path: no symbol, or a
  // symbol that matched nothing (an ambiguous symbol never consults the name).
  const nameMatches = await resolveByNameBatch(rows, symbolMatches);

  // Resolve once per distinct (symbol, name) pair — brokerage exports repeat the
  // same instrument across many rows.
  const cache = new Map();
  const resolveKey = (symbol, name) => `${symbol || ''}\x00${name || ''}`;

  const classify = (symbolRaw, nameRaw) => {
    const symbol = String(symbolRaw || '').trim();
    if (symbol) {
      const entry = symbolMatches.get(symbol.toLowerCase());
      if (entry) {
        // Exactly one active match → symbol resolution; >1 → ambiguous, and the
        // old code returned immediately without trying the name.
        if (entry.count === 1) return { investmentId: entry.id, matchSource: 'symbol' };
        return { investmentId: null, matchSource: null };
      }
      // Zero symbol matches → fall through to the name path.
    }
    const name = String(nameRaw || '').trim();
    if (name) {
      const entry = nameMatches.get(name.toLowerCase());
      if (entry && entry.count === 1) return { investmentId: entry.id, matchSource: 'name_exact' };
      // Ambiguous (>1) or zero name matches → unresolved.
    }
    return { investmentId: null, matchSource: null };
  };

  const ids = [];
  const investmentIds = [];
  const matchSources = [];
  const counts = { symbol: 0, name_exact: 0, unresolved: 0 };

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
    counts[resolved.matchSource ?? 'unresolved'] += 1;

    seen++;
    if (onProgress && (seen % 200 === 0 || seen === total)) {
      onProgress({ phase: 'matching', current: seen, total });
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

  logger.info('[portfolio-pipeline:match] done', { batchId, total, counts });
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
 * @param {{ symbol_raw: string }[]} rows
 * @returns {Promise<Map<string, { id: number, count: number }>>} keyed by lowercased symbol
 */
async function resolveBySymbolBatch(rows) {
  const symbols = new Set();
  for (const row of rows) {
    const symbol = String(row.symbol_raw || '').trim();
    if (symbol) symbols.add(symbol.toLowerCase());
  }
  const map = new Map();
  if (symbols.size === 0) return map;
  const r = await query(
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
 * Resolve the still-unresolved remainder by exact (case- and whitespace-
 * insensitive) name in one query. Only rows whose symbol matched nothing — or
 * that carry no symbol — reach the name path; a row with an ambiguous symbol is
 * excluded, mirroring the old function's early return before name matching.
 *
 * @param {{ symbol_raw: string, name_raw: string }[]} rows
 * @param {Map<string, { id: number, count: number }>} symbolMatches
 * @returns {Promise<Map<string, { id: number, count: number }>>} keyed by lowercased trimmed name
 */
async function resolveByNameBatch(rows, symbolMatches) {
  const names = new Set();
  for (const row of rows) {
    const symbol = String(row.symbol_raw || '').trim();
    // Skip rows already handled by a symbol match or blocked by an ambiguous one.
    if (symbol && symbolMatches.has(symbol.toLowerCase())) continue;
    const name = String(row.name_raw || '').trim();
    if (name) names.add(name.toLowerCase());
  }
  const map = new Map();
  if (names.size === 0) return map;
  const r = await query(
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
