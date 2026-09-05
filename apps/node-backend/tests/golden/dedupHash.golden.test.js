/**
 * Dedup hash golden — locks backward-compat of transaction dedup hashes.
 *
 * The import pipeline (services/importPipeline/*) and manual-add paths both
 * depend on these hashes being stable across releases. A drift in the
 * normalization rules would silently break duplicate detection for already-
 * imported rows. Regenerating the fixture must be a deliberate migration.
 */

import { describe, it } from 'vitest';
import { runGolden } from './runGolden.js';
import {
  __createTransactionHash as createTransactionHash,
  __createManualTransactionHash as createManualTransactionHash,
} from '../../src/services/deduplication.js';

/**
 * @param {{ cases: Array<{ kind: 'transaction' | 'manual', label: string, args: any }> }} input
 */
function computeHashes(input) {
  return {
    hashes: input.cases.map((c) => {
      if (c.kind === 'manual') {
        return { label: c.label, hash: createManualTransactionHash(c.args) };
      }
      const args = { ...c.args, date: new Date(c.args.date) };
      return { label: c.label, hash: createTransactionHash(args) };
    }),
  };
}

describe('dedup hash golden', () => {
  it('hash-cases locked', async () => {
    await runGolden('dedup/hash-cases', computeHashes);
  });
});
