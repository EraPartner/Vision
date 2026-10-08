import { describe, it } from 'vitest';
import { runGolden } from '../golden/runGolden.ts';
import {
  __createTransactionHash as createTransactionHash,
  __createManualTransactionHash as createManualTransactionHash,
} from '../../src/services/deduplication.ts';

/**
 * Golden-fixture regression suite for services/deduplication hash functions.
 * Locks SHA-256 outputs so any unintended normalization change is caught.
 * Run `UPDATE_GOLDENS=1 bun vitest run dedup.golden` to re-baseline.
 */
type TransactionHashInput = Parameters<typeof createTransactionHash>[0];
type ManualHashInput = Parameters<typeof createManualTransactionHash>[0];

/** One JSON fixture case; `args.date` arrives as an ISO string for 'transaction'. */
interface HashCase {
  kind: string;
  label: string;
  args: Record<string, unknown>;
}

function runCase(c: HashCase) {
  if (c.kind === 'transaction') {
    const args = { ...c.args };
    if (typeof args.date === 'string') {
      args.date = new Date(args.date);
    }
    return { label: c.label, hash: createTransactionHash(args as unknown as TransactionHashInput) };
  }
  if (c.kind === 'manual') {
    return { label: c.label, hash: createManualTransactionHash(c.args as unknown as ManualHashInput) };
  }
  throw new Error(`unknown case kind: ${c.kind}`);
}

describe('deduplication hash golden', () => {
  it('locks hash outputs across transaction + manual variants', async () => {
    await runGolden<{ cases: HashCase[] }>('dedup/hash-cases', (input) => ({
      hashes: input.cases.map(runCase),
    }));
  });
});
