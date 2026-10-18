/**
 * Dedup hash golden — locks backward-compat of transaction dedup hashes.
 *
 * Import hashes remain stable. Manual-v3 deliberately includes currency and
 * canonical values; real-DB tests verify fallback for earlier claim recipes.
 * Its fixture was independently encoded from the reviewed versioned recipe.
 */

import { describe, it } from 'vitest';
import { runGolden } from './runGolden.ts';
import {
  __createTransactionHash as createTransactionHash,
  __createManualTransactionHash as createManualTransactionHash,
} from '../../src/services/deduplication.ts';
import type {
  FieldHashInput,
  ManualHashInput,
} from '../../src/services/deduplication.ts';

/** `dedup/hash-cases.input.json`: transaction cases carry `date` as an ISO string. */
type HashCase =
  | { kind: 'manual'; label: string; args: ManualHashInput }
  | {
      kind: 'transaction';
      label: string;
      args: Omit<FieldHashInput, 'date'> & { date: string };
    };

function computeHashes(input: { cases: HashCase[] }) {
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
