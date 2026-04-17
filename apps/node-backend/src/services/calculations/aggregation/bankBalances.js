/**
 * Bank balances aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getBankBalances. Current
 * balance + trailing sparkline per bank account; MV-backed.
 */

import infoRepository from '../../../repositories/infoRepository.js';
import { buildEnvelope } from './_envelope.js';

export async function computeBankBalances({
  targetCurrency = 'EUR',
} = {}) {
  const data = await infoRepository.getBankBalances(targetCurrency);
  return buildEnvelope(data, { source: 'mv' });
}

export default { computeBankBalances };
