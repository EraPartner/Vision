/**
 * Shared request-scoped fetch helpers for portfolio/tax AI-chat tools.
 *
 * A single chat turn often runs several portfolio/tax tools that each fetch
 * the same active-investment set and its transactions. These helpers route
 * those reads through the per-turn `cache` (see ../toolCache.js) so identical
 * fetches hit the database once. When `cache` is absent the read runs directly.
 */

import { investmentRepository } from '../../../repositories/investmentRepository.js';
import { portfolioTransactionRepository } from '../../../repositories/portfolioTransactionRepository.js';
import { memoizeAsync } from '../toolCache.js';

/**
 * Active investments, optionally filtered by asset class.
 * @param {Map<string, Promise<any>>|undefined} cache
 * @param {string|null} assetClass
 */
export function loadActiveInvestments(cache, assetClass = null) {
  return memoizeAsync(cache, `inv:${assetClass ?? '*'}`, () =>
    investmentRepository.getAll({ limit: 10_000, offset: 0, active: true, assetClass }));
}

/**
 * Transactions for the given investment ids. Keyed by the same asset-class
 * discriminator as {@link loadActiveInvestments} (since `ids` is derived from
 * it) plus the optional transaction type.
 *
 * @param {Map<string, Promise<any>>|undefined} cache
 * @param {string|null} assetClass  discriminator used to build the cache key
 * @param {number[]} ids
 * @param {{ type?: string|null }} [opts]
 */
export function loadTransactionsForInvestments(cache, assetClass, ids, { type = null } = {}) {
  if (ids.length === 0) return Promise.resolve([]);
  return memoizeAsync(cache, `txn:${assetClass ?? '*'}:${type ?? 'all'}`, () =>
    portfolioTransactionRepository.getAllByInvestmentIds({
      investmentIds: ids,
      ...(type ? { type } : {}),
      perInvestmentLimit: 5000,
    }));
}
