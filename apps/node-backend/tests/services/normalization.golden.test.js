import { describe, it } from 'vitest';
import { runGolden } from '../golden/runGolden.js';
import { normalizeForMatching } from '../../src/services/textNormalization.js';

/**
 * Golden-fixture regression suite for normalizeForMatching (Phase 6).
 *
 * Locks the canonical-form contract used by pg_trgm matching and the
 * recipients UNIQUE(normalized_name) constraint. Any change to the
 * tokenization/sort/filter rules will surface here.
 *
 * Inputs/outputs live under tests/golden/__fixtures__/normalization/*.
 * Re-baseline with `UPDATE_GOLDENS=1 bun run test normalization.golden`.
 */
describe('normalizeForMatching golden', () => {
  it('simple two-word uppercases', async () => {
    await runGolden('normalization/simple-two-word', normalizeForMatching);
  });

  it('sorts tokens alphabetically regardless of input order', async () => {
    await runGolden('normalization/token-order-sort', normalizeForMatching);
  });

  it('filters single-letter initials', async () => {
    await runGolden('normalization/initial-filter', normalizeForMatching);
  });

  it('filters middle-name initial', async () => {
    await runGolden('normalization/initials-middle', normalizeForMatching);
  });

  it('preserves single-digit tokens', async () => {
    await runGolden('normalization/digit-preserved', normalizeForMatching);
  });

  it('strips commas and periods as separators', async () => {
    await runGolden('normalization/punctuation-strip', normalizeForMatching);
  });

  it('single-word name passes through uppercased', async () => {
    await runGolden('normalization/single-word', normalizeForMatching);
  });

  it('all-initials falls back to sorted originals', async () => {
    await runGolden('normalization/all-initials', normalizeForMatching);
  });

  it('empty string stays empty', async () => {
    await runGolden('normalization/empty-string', normalizeForMatching);
  });

  it('word + digit sorts digit first', async () => {
    await runGolden('normalization/store-with-digit', normalizeForMatching);
  });
});
