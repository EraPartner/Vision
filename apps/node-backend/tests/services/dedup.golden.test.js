import { describe, it } from 'vitest';
import { runGolden } from '../golden/runGolden.js';
import {
  __createTransactionHash as createTransactionHash,
  __createManualTransactionHash as createManualTransactionHash,
} from '../../src/services/deduplication.js';

/**
 * Golden-fixture regression suite for services/deduplication hash functions.
 * Locks SHA-256 outputs so any unintended normalization change is caught.
 * Run `UPDATE_GOLDENS=1 bun vitest run dedup.golden` to re-baseline.
 */
function runCase(c) {
  if (c.kind === 'transaction') {
    const args = { ...c.args };
    if (typeof args.date === 'string') {
      args.date = new Date(args.date);
    }
    return { label: c.label, hash: createTransactionHash(args) };
  }
  if (c.kind === 'manual') {
    return { label: c.label, hash: createManualTransactionHash(c.args) };
  }
  throw new Error(`unknown case kind: ${c.kind}`);
}

describe('deduplication hash golden', () => {
  it('locks hash outputs across transaction + manual variants', async () => {
    await runGolden('dedup/hash-cases', (input) => ({
      hashes: input.cases.map(runCase),
    }));
  });
});
