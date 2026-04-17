/**
 * Average-vs-current spending aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getAverageVsCurrentSpending.
 * Computed live today (no MV); source flagged 'live' for meta.
 */

import infoRepository from '../../../repositories/infoRepository.js';
import { buildEnvelope } from './_envelope.js';

export async function computeAverageVsCurrent({
  targetCurrency = 'EUR',
} = {}) {
  const data = await infoRepository.getAverageVsCurrentSpending(targetCurrency);
  return buildEnvelope(data, { source: 'live' });
}

export default { computeAverageVsCurrent };
