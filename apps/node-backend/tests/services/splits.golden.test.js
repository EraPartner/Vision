import { describe, it } from 'vitest';
import { runGolden } from '../golden/runGolden.js';
import {
  computeOwedSummary,
  validateSplitAllocation,
  validateBatchSplitAllocation,
  validatePaymentAmount,
} from '../../src/lib/calculations/splits.js';

/**
 * Golden-fixture regression suite for lib/calculations/splits.
 * Inputs live in tests/golden/__fixtures__/splits/*.input.json.
 * Run `UPDATE_GOLDENS=1 bun run test splits.golden` to re-baseline.
 *
 * Covers Phase 4 invariants:
 *   - owed-summary projection (roundToCents, zero-balance filter, sort desc)
 *   - single-split over-allocation guard (sum(splits) ≤ transaction total)
 *   - batch allocation guard (aggregate over new splits)
 *   - payment overpayment guard (sum(payments) ≤ split.amount)
 */
describe('splits.computeOwedSummary golden', () => {
  it('empty input returns empty array', async () => {
    await runGolden('splits/owedSummary-empty', computeOwedSummary);
  });

  it('single recipient with outstanding balance', async () => {
    await runGolden('splits/owedSummary-single-recipient', computeOwedSummary);
  });

  it('multi-recipient sorted by remaining DESC', async () => {
    await runGolden('splits/owedSummary-multi-recipient', computeOwedSummary);
  });

  it('fully-settled rows filtered out', async () => {
    await runGolden('splits/owedSummary-fully-settled-filtered', computeOwedSummary);
  });

  it('stringified NUMERIC values coerced correctly', async () => {
    await runGolden('splits/owedSummary-stringified-numbers', computeOwedSummary);
  });
});

describe('splits.validateSplitAllocation golden', () => {
  it('within budget', async () => {
    await runGolden('splits/validateSplitAllocation-ok', validateSplitAllocation);
  });

  it('rejects over-allocation', async () => {
    await runGolden('splits/validateSplitAllocation-over', validateSplitAllocation);
  });

  it('rejects non-positive amount', async () => {
    await runGolden('splits/validateSplitAllocation-non-positive', validateSplitAllocation);
  });

  it('accepts within cent tolerance', async () => {
    await runGolden(
      'splits/validateSplitAllocation-tolerance-boundary',
      validateSplitAllocation,
    );
  });
});

describe('splits.validateBatchSplitAllocation golden', () => {
  it('within budget', async () => {
    await runGolden('splits/validateBatchSplitAllocation-ok', validateBatchSplitAllocation);
  });

  it('rejects aggregate over-allocation', async () => {
    await runGolden('splits/validateBatchSplitAllocation-over', validateBatchSplitAllocation);
  });

  it('rejects empty batch', async () => {
    await runGolden(
      'splits/validateBatchSplitAllocation-empty',
      validateBatchSplitAllocation,
    );
  });

  it('rejects batch with negative member', async () => {
    await runGolden(
      'splits/validateBatchSplitAllocation-negative-member',
      validateBatchSplitAllocation,
    );
  });
});

describe('splits.validatePaymentAmount golden', () => {
  it('within outstanding balance', async () => {
    await runGolden('splits/validatePaymentAmount-ok', validatePaymentAmount);
  });

  it('rejects overpayment', async () => {
    await runGolden('splits/validatePaymentAmount-over', validatePaymentAmount);
  });

  it('accepts exact settle payment', async () => {
    await runGolden('splits/validatePaymentAmount-exact-settle', validatePaymentAmount);
  });

  it('rejects non-positive amount', async () => {
    await runGolden('splits/validatePaymentAmount-non-positive', validatePaymentAmount);
  });
});
