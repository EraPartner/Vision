/**
 * Atomic account merge (ADR-088). Merges one or more SOURCE accounts into a TARGET
 * (survivor): every reference to a source account_id is repointed to the target, then
 * the source rows are deleted — so the accounts become one everywhere.
 *
 * Mirrors the recipient merge (ADR-014) pattern: single transaction, FOR UPDATE locks,
 * repoint-then-delete. The account_id FKs are ON DELETE RESTRICT, so deletion only
 * succeeds once every reference has moved — which is exactly the integrity guarantee.
 *
 * transactions / planned_transactions also get bank_account = target.name so the
 * dual-write trigger (migration 0051) keeps account_id at the target and a later edit
 * can't re-resolve the old name back into a fresh account (un-merge).
 *
 * Overlapping-stamp guard (§1 F2): per-row `balance` stamps are per-source-bank
 * running balances. When two accounts that were BOTH being stamped over the same
 * period merge, the stamps interleave in one partition and the anchor+delta
 * computation (COMPUTED_BALANCE_LATERAL) anchors on whichever source's latest
 * stamp is most recent — silently dropping the other bank's balance — while the
 * survivor's stored `statement_balance` keeps anchoring drift against the shifted
 * figure. The merge detects this (overlapping stamped-date ranges across >1
 * original account) and clears the survivor's now-invalidated statement anchor.
 * Historical per-row stamps are never rewritten (they are historical facts);
 * clearing the statement anchor is the documented, reversible choice — the user
 * can re-reconcile with a fresh statement. Sequential merges (old account closed
 * before the new one opened — the phantom-dedup use case) don't overlap and are
 * untouched.
 *
 * Colliding-anchor guard: opening-balance anchors are unique per
 * (account, currency) (migration 0077), so merging two accounts that each hold
 * one in the same currency is unsatisfiable. That is refused up front with a
 * 400 rather than left to surface as a mid-transaction 23505 — see
 * collidingAnchorCurrencies.
 */

import { query, withTransaction } from '../database/connection.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { roundToCents, toDecimal, toNumber } from '../lib/money.js';
import { computedBalanceByCurrencyAggLateral } from '../repositories/accountBalanceSql.js';
import { convertWithRates, loadCurrentRates } from './currency/currencyConversionService.js';
import { accountRepository } from '../repositories/accountRepository.js';
import { transactionRepository } from '../repositories/transactionRepository.js';
import { plannedTransactionRepository } from '../repositories/plannedTransactionRepository.js';
import { portfolioTransactionRepository } from '../repositories/portfolioTransactionRepository.js';

/**
 * Do the stamped-balance histories of >1 original account overlap in time?
 * True ⇒ the merged partition's anchor is ambiguous (see module header) and
 * the survivor's statement anchor must be cleared. Ranges are 'YYYY-MM-DD'
 * strings (lexicographic compare == date compare). Pairwise over ≤ a handful
 * of accounts — O(n²) is fine and keeps the predicate pure/testable.
 *
 * @param {{ account_id:number, min_date:string, max_date:string }[]} ranges
 * @returns {boolean}
 */
export function stampRangesOverlap(ranges) {
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      // Two closed ranges [minA,maxA] and [minB,maxB] overlap iff each starts
      // on or before the other ends.
      if (ranges[i].min_date <= ranges[j].max_date && ranges[j].min_date <= ranges[i].max_date) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Currencies in which MORE THAN ONE of the merged accounts holds an
 * opening-balance anchor (`transfer_source = 'opening'`).
 *
 * The repoint moves every anchor onto the survivor, and
 * `ux_transactions_opening_anchor` — UNIQUE (account_id, currency) WHERE
 * transfer_source = 'opening' (migration 0077) — permits exactly one per
 * (account, currency). Two anchors in the same currency therefore make the
 * merge unsatisfiable: Postgres raises 23505 mid-transaction, which nothing
 * maps to an HTTP status. It is a genuine ambiguity rather than a bug to paper
 * over — the two anchors state two different opening balances for what the user
 * is asserting is one account, and picking a winner would silently discard the
 * other account's carried-in balance. So the merge refuses and the user removes
 * one anchor first.
 *
 * Pure (no I/O), same as {@link stampRangesOverlap}, so the predicate is
 * directly testable and preview/merge can share it verbatim.
 *
 * @param {{ account_id:number, currency:string }[]} anchors
 * @returns {string[]} colliding currency codes, ordered, no duplicates
 */
export function collidingAnchorCurrencies(anchors) {
  /** @type {Map<string, Set<number>>} */
  const accountsByCurrency = new Map();
  for (const { account_id: accountId, currency } of anchors || []) {
    const code = (currency || 'EUR').toUpperCase();
    if (!accountsByCurrency.has(code)) accountsByCurrency.set(code, new Set());
    accountsByCurrency.get(code).add(accountId);
  }
  return [...accountsByCurrency.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([code]) => code)
    .sort();
}

/**
 * @param {number} targetId  the survivor
 * @param {number[]} sourceIds  accounts to merge into the target and delete
 * @returns {Promise<{ into:number, merged:number[], reassigned:{transactions:number,planned:number,portfolio:number,funding:number}, stampsInterleaved:boolean }>}
 */
export async function mergeAccounts(targetId, sourceIds) {
  if (!Number.isInteger(targetId)) throw new ValidationError('target account id must be an integer');
  const ids = [...new Set((sourceIds || []).filter((id) => Number.isInteger(id) && id !== targetId))];
  if (!ids.length) throw new ValidationError('Provide at least one distinct source account to merge');

  // Composed from repository methods: the ambient transaction context routes
  // each repo call onto this transaction's client, so every statement below
  // shares the FOR UPDATE locks taken here and rolls back atomically.
  return withTransaction(async () => {
    // Lock the survivor + sources so concurrent merges serialize.
    const tgt = await accountRepository.lockByIdForMerge(targetId);
    if (!tgt) throw new NotFoundError(`Account ${targetId} not found`);
    const targetName = tgt.name;

    const srcRows = await accountRepository.lockByIdsForMerge(ids);
    const found = new Set(srcRows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new NotFoundError(`Account(s) not found: ${missing.join(', ')}`);

    // Overlapping-stamp guard (§1 F2, module header): capture per-original-
    // account stamped ranges before the repoint erases the provenance.
    const stampRanges = await transactionRepository.getStampedDateRangesByAccount([targetId, ...ids]);
    const stampsInterleaved = stampRangesOverlap(stampRanges);

    // Colliding-anchor guard: read under the same locks, before the repoint that
    // would violate ux_transactions_opening_anchor. Refuse rather than choose an
    // anchor for the user (see collidingAnchorCurrencies).
    const collisions = collidingAnchorCurrencies(
      await transactionRepository.getOpeningAnchorsByAccount([targetId, ...ids]),
    );
    if (collisions.length) {
      throw new ValidationError(
        `More than one of these accounts has an opening balance in ${collisions.join(', ')}. `
        + 'Remove the opening balance from all but one of them, then merge '
        + '(an account can hold only one opening balance per currency).',
      );
    }

    const txCount = await transactionRepository.repointAccount(targetId, targetName, ids);
    const plannedCount = await plannedTransactionRepository.repointAccount(targetId, targetName, ids);

    // Portfolio lots: account_id lives on the inheritance base (an UPDATE cascades to the child
    // tables) or, in the flat schema, on the table itself. (portfolio_transactions is a view in the
    // inheritance schema and is not updatable.)
    const portfolioCount = await portfolioTransactionRepository.repointAccount(targetId, ids);

    // Accounts that used a merged source as their funding/settlement account.
    const fundingCount = await accountRepository.repointFundingAccount(targetId, ids);

    // Interleaved stamps invalidate the survivor's statement anchor: drift
    // would be computed against a figure reconciled for a pre-merge partition.
    // Clear it (reversible — the user re-reconciles with a fresh statement);
    // per-row balance stamps stay untouched (historical facts).
    if (stampsInterleaved) {
      await accountRepository.clearStatementAnchor(targetId);
    }

    await accountRepository.deleteMergedSources(ids, targetId);

    return {
      into: targetId,
      merged: ids,
      reassigned: {
        transactions: txCount,
        planned: plannedCount,
        portfolio: portfolioCount,
        funding: fundingCount,
      },
      // Surfaced so the merge dialog (WP-B5) can warn that the statement
      // anchor was cleared and the merged history interleaves two banks.
      stampsInterleaved,
    };
  });
}

/**
 * Read-only preview of merging `sourceId` INTO `targetId` (the survivor) —
 * backs GET /api/accounts/:id/merge-preview?into=. No mutation, no locks:
 *   - reassigned.* — row counts that WOULD move (same categories mergeAccounts
 *     repoints).
 *   - projectedBalance — the post-merge computed balance: the anchor+delta
 *     definition evaluated PER CURRENCY (computedBalanceByCurrencyAggLateral)
 *     over the UNION of survivor + source active rows as if they were already
 *     one account, each partition then converted at its own current rate.
 *     Reported in the survivor's native currency (projectedBalanceCurrency) —
 *     the same currency, the same builder and the same conversion the hub uses
 *     for computed_balance, so the figure the dialog previews is the figure the
 *     hub will show once the merge lands. Summing the union cross-currency
 *     first and converting once (what this hand-inlined before) added a EUR
 *     amount to a USD amount as bare numbers.
 *   - stampsInterleaved — same detection the merge guard uses (would the merge
 *     invalidate the survivor's statement anchor).
 *   - openingAnchorCollision — same detection the merge guard uses: both
 *     accounts hold an opening balance in one currency, so `POST /merge` will
 *     refuse with a 400 (see collidingAnchorCurrencies). Preview reports it
 *     alongside stampsInterleaved so the dialog can warn BEFORE the click; the
 *     projected balance is still returned, but it cannot be realized until an
 *     anchor is removed.
 *
 * @param {number} sourceId  the account that would be merged away
 * @param {number} targetId  the survivor (`?into=`)
 * @returns {Promise<{ into:number, source:number, reassigned:{transactions:number,planned:number,portfolio:number,funding:number}, projectedBalance:number, projectedBalanceCurrency:string, stampsInterleaved:boolean, openingAnchorCollision:boolean }>}
 */
export async function previewMerge(sourceId, targetId) {
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    throw new ValidationError('source account id must be a positive integer');
  }
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw new ValidationError('into must be a positive integer account id');
  }
  if (targetId === sourceId) {
    throw new ValidationError('An account cannot be merged into itself');
  }

  const accounts = await query(
    'SELECT id, currency FROM accounts WHERE id = ANY($1::int[])',
    [[sourceId, targetId]],
  );
  const byId = new Map(accounts.rows.map(
    (/** @type {{ id: number, currency: string }} */ r) => [r.id, r],
  ));
  if (!byId.has(targetId)) throw new NotFoundError(`Account ${targetId} not found`);
  if (!byId.has(sourceId)) throw new NotFoundError(`Account ${sourceId} not found`);

  // Same table set mergeAccounts repoints, as COUNTs. The relation probe is the
  // same repo helper the merge write path uses, so preview and merge can never
  // disagree about which table carries account_id.
  const portfolioTable = await portfolioTransactionRepository.getAccountIdRelation();

  const unionIds = [targetId, sourceId];
  const [txCount, plannedCount, portfolioCount, fundingCount, projected, rates, stampRanges, anchors] = await Promise.all([
    query('SELECT COUNT(*) AS n FROM transactions WHERE account_id = $1', [sourceId]),
    query('SELECT COUNT(*) AS n FROM planned_transactions WHERE account_id = $1', [sourceId]),
    query(`SELECT COUNT(*) AS n FROM ${portfolioTable} WHERE account_id = $1`, [sourceId]),
    query('SELECT COUNT(*) AS n FROM accounts WHERE funding_account_id = $1', [sourceId]),
    // Per-currency anchor+delta over the union set, via the shared hub builder:
    // within each currency the most recent stamped row across BOTH accounts
    // anchors and every active row of that currency after it is the delta. The
    // account expression is the LITERAL `ANY($1::int[])` (never user input), so
    // the builder's `t.account_id = ${account}` becomes the union predicate —
    // which is exactly what the merged account's rows will look like.
    query(
      `SELECT bp.balance_parts
         FROM (SELECT 1) merge_drv
         ${computedBalanceByCurrencyAggLateral({ account: 'ANY($1::int[])' })}`,
      [unionIds],
    ),
    // One rate table for every partition; these are CURRENT balances, so each
    // converts at today's rate (see computedBalanceByCurrencyLateral).
    loadCurrentRates(),
    transactionRepository.getStampedDateRangesByAccount(unionIds),
    transactionRepository.getOpeningAnchorsByAccount(unionIds),
  ]);

  const targetCurrency = (byId.get(targetId).currency || 'EUR').toUpperCase();
  /** @type {Array<{ currency: string, balance: string }>} */
  const partitions = projected.rows[0]?.balance_parts ?? [];
  let total = toDecimal(0);
  for (const part of partitions) {
    total = total.plus(toDecimal(convertWithRates(
      toNumber(toDecimal(part.balance)),
      (part.currency || 'EUR').toUpperCase(),
      targetCurrency,
      rates,
    )));
  }

  return {
    into: targetId,
    source: sourceId,
    reassigned: {
      transactions: parseInt(txCount.rows[0].n, 10),
      planned: parseInt(plannedCount.rows[0].n, 10),
      portfolio: parseInt(portfolioCount.rows[0].n, 10),
      funding: parseInt(fundingCount.rows[0].n, 10),
    },
    // Partition balances arrive as NUMERIC-backed strings; emit the converted
    // total as a rounded number (banker's, cents), like the hub's computed_balance.
    projectedBalance: toNumber(roundToCents(total)),
    projectedBalanceCurrency: targetCurrency,
    stampsInterleaved: stampRangesOverlap(stampRanges),
    openingAnchorCollision: collidingAnchorCurrencies(anchors).length > 0,
  };
}

export default { mergeAccounts, previewMerge, stampRangesOverlap, collidingAnchorCurrencies };
