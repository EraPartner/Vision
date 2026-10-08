/**
 * Average-vs-current spending aggregation.
 *
 * Thin calc-layer wrapper over infoRepository.getAverageVsCurrentSpending.
 * Computed live today (no MV); source flagged 'live' for meta.
 */

import infoRepository from '../../../repositories/infoRepository.ts';
import { buildEnvelope } from './_envelope.ts';
import { assertNoNaN } from './_invariants.ts';

export async function computeAverageVsCurrent({
  targetCurrency = 'EUR',
}: { targetCurrency?: string } = {}) {
  const data = await infoRepository.getAverageVsCurrentSpending(targetCurrency);
  assertNoNaN(data, 'computeAverageVsCurrent');
  return buildEnvelope(data, { source: 'live' });
}

export default { computeAverageVsCurrent };
