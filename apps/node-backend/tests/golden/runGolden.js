/**
 * Golden-fixture harness (ADR-009 / Phase 0).
 *
 * Each non-trivial calculation in services/calculations/* pairs with:
 *   tests/golden/__fixtures__/<name>.input.json
 *   tests/golden/__fixtures__/<name>.expected.json
 *
 * The harness loads input, runs the pure function, and deep-compares against
 * expected. Set UPDATE_GOLDENS=1 to rewrite expected from the current output.
 *
 * Usage inside a vitest spec:
 *
 *   import { describe, it, expect } from 'vitest';
 *   import { runGolden } from '../golden/runGolden.js';
 *   import { generateLoanSchedule } from '../../src/services/calculations/loanSchedule.js';
 *
 *   describe('loanSchedule golden', () => {
 *     it('amortizing-standard', async () => {
 *       await runGolden('loanSchedule/amortizing-standard', (input) =>
 *         generateLoanSchedule(input),
 *       );
 *     });
 *   });
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/**
 * Run a fixture-backed regression check.
 * @param {string} name fixture slug, e.g. "loanSchedule/amortizing-standard"
 * @param {(input: any) => any | Promise<any>} fn function under test
 */
export async function runGolden(name, fn) {
  const inputPath = join(FIXTURE_ROOT, `${name}.input.json`);
  const expectedPath = join(FIXTURE_ROOT, `${name}.expected.json`);

  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const actual = await fn(input);

  if (process.env.UPDATE_GOLDENS === '1') {
    await mkdir(dirname(expectedPath), { recursive: true });
    await writeFile(expectedPath, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    return;
  }

  let expected;
  try {
    expected = JSON.parse(await readFile(expectedPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `Missing golden fixture at ${expectedPath}. Run with UPDATE_GOLDENS=1 to create it.`,
      );
    }
    throw err;
  }

  // Normalize via JSON round-trip so Date/undefined/Map don't cause false diffs
  const normalizedActual = JSON.parse(JSON.stringify(actual));
  expect(normalizedActual).toStrictEqual(expected);
}
