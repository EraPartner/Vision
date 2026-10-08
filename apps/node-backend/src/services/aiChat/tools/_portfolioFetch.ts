/**
 * Shared request-scoped fetch helpers for portfolio/tax AI-chat tools.
 *
 * A single chat turn often runs several portfolio/tax tools that each fetch
 * the same active-investment set and its transactions. These helpers route
 * those reads through the per-turn `cache` (see ../toolCache.js) so identical
 * fetches hit the database once. When `cache` is absent the read runs directly.
 */

import { investmentRepository } from '../../../repositories/investmentRepository.ts';
import { portfolioTransactionRepository } from '../../../repositories/portfolioTransactionRepository.ts';
import { memoizeAsync } from '../toolCache.ts';
import type { ToolCache } from '../toolCache.ts';
import type {
  InvestmentRow,
  PortfolioTransactionRow,
} from '../../../types/rows.ts';

/**
 * Active investments, optionally filtered by asset class.
 */
export function loadActiveInvestments(
  cache: ToolCache | undefined,
  assetClass: string | null = null,
): Promise<InvestmentRow[]> {
  return memoizeAsync(cache, `inv:${assetClass ?? '*'}`, () =>
    investmentRepository.getAll({ limit: 10_000, offset: 0, active: true, assetClass }));
}

/**
 * Transactions for the given investment ids. Keyed by the same asset-class
 * discriminator as {@link loadActiveInvestments} (since `ids` is derived from
 * it) plus the optional transaction type.
 *
 * @param assetClass  discriminator used to build the cache key
 */
export function loadTransactionsForInvestments(
  cache: ToolCache | undefined,
  assetClass: string | null,
  ids: number[],
  { type = null }: { type?: string | null } = {},
): Promise<PortfolioTransactionRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return memoizeAsync(cache, `txn:${assetClass ?? '*'}:${type ?? 'all'}`, () =>
    portfolioTransactionRepository.getAllByInvestmentIds({
      investmentIds: ids,
      ...(type ? { type } : {}),
      perInvestmentLimit: 5000,
    }));
}
