import { describe, it } from 'vitest';
import { runGolden } from '../golden/runGolden.js';
import { generateLoanRepaymentSchedule } from '../../src/services/calculations/loanSchedule.js';

/**
 * Golden-fixture regression suite for services/calculations/loanSchedule.
 * Inputs live in tests/golden/__fixtures__/loanSchedule/*.input.json.
 * Run `UPDATE_GOLDENS=1 bun run test loanSchedule.golden` to re-baseline.
 */
describe('loanSchedule golden', () => {
  it('amortizing-standard (12mo @ 6% APR, €12k)', async () => {
    await runGolden('loanSchedule/amortizing-standard', generateLoanRepaymentSchedule);
  });

  it('amortizing-zero-apr (0% APR splits principal evenly)', async () => {
    await runGolden('loanSchedule/amortizing-zero-apr', generateLoanRepaymentSchedule);
  });

  it('amortizing-month-end-clamp (Jan 31 start clamps through Feb/Apr)', async () => {
    await runGolden('loanSchedule/amortizing-month-end-clamp', generateLoanRepaymentSchedule);
  });

  it('amortizing-single-month (1mo term, full principal due immediately)', async () => {
    await runGolden('loanSchedule/amortizing-single-month', generateLoanRepaymentSchedule);
  });

  it('amortizing-long-term (360mo mortgage)', async () => {
    await runGolden('loanSchedule/amortizing-long-term', generateLoanRepaymentSchedule);
  });

  it('fixed-principal (flat €1k principal/mo)', async () => {
    await runGolden('loanSchedule/fixed-principal', generateLoanRepaymentSchedule);
  });

  it('interest-only (balloon at term)', async () => {
    await runGolden('loanSchedule/interest-only', generateLoanRepaymentSchedule);
  });
});
