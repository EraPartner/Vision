/**
 * Bank balances aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getBankBalances. Current
 * balance + trailing sparkline per bank account; MV-backed.
 */

import infoRepository from '../../../repositories/infoRepository.js';
import { buildEnvelope } from './_envelope.js';
import { assertNoNaN } from './_invariants.js';

export async function computeBankBalances({
  targetCurrency = 'EUR',
} = {}) {
  const data = await infoRepository.getBankBalances(targetCurrency);
  assertNoNaN(data, 'computeBankBalances');
  return buildEnvelope(data, { source: 'mv' });
}

export default { computeBankBalances };
