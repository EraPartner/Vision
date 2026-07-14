/**
 * Bank balances aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getBankBalances. Current
 * balance + trailing sparkline per bank account. This runs live SQL (not an
 * MV read), so results are wrapped in the shared inflight cache (~60s TTL) and
 * the envelope is labelled `source: 'live'`. The cache is busted from the same
 * seam as the net-worth cache (invalidatePortfolioCaches) so account mutations
 * clear it too.
 */

import infoRepository from '../../../repositories/infoRepository.js';
import { buildEnvelope } from './_envelope.js';
import { assertNoNaN } from './_invariants.js';
import {
  bankBalancesResponseCache,
  BANK_BALANCES_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from '../../../routes/info/_cache.js';

export async function computeBankBalances({
  targetCurrency = 'EUR',
} = {}) {
  return resolveCacheWithInflight(bankBalancesResponseCache, targetCurrency, {
    ttlMs: BANK_BALANCES_CACHE_TTL_MS,
    requireData: true,
    keepPreviousData: true,
    loader: async () => {
      const data = await infoRepository.getBankBalances(targetCurrency);
      assertNoNaN(data, 'computeBankBalances');
      return buildEnvelope(data, { source: 'live' });
    },
  });
}

export default { computeBankBalances };
