import { describe, it } from 'vitest';
import { runGolden } from '../golden/runGolden.js';
import { __findTransferMatches as findTransferMatches } from '../../src/services/calculations/transfers.js';

/**
 * Golden-fixture regression suite for internal-transfer matching (ADR-083).
 * Locks the auto-pair / suggestion classification across the key cases:
 * clean cross-account pair, settlement-lag pair, one-directional outflow,
 * same-account refund (not a transfer), ambiguous contention, out-of-window,
 * cross-currency, and already-marked / manual rows.
 * Re-baseline with: UPDATE_GOLDENS=1 bun vitest run transfers.golden
 */
describe('transfer matching golden', () => {
  it('classifies auto-pairs vs ambiguous suggestions', async () => {
    await runGolden('transfers/match-cases', (input) =>
      findTransferMatches(input.transactions, input.options),
    );
  });
});
