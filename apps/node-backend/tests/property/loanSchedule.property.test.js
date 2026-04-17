/**
 * Property test: loan schedule principal invariants (Phase 8).
 *
 * Invariant from plan: `sum(principal_payments) == principal` within 1 cent.
 *
 * Rationale: any schedule — regardless of loan_type, APR, term, start date, or
 * payment day — must fully amortize the principal by the last installment.
 * Floating-point rounding across 360 rows can drift; cent tolerance is the
 * business-meaningful bound.
 */

import { describe, it, expect } from 'vitest';
import { generateLoanRepaymentSchedule } from '../../src/services/calculations/loanSchedule.js';

const CENT = 0.01;

const LOAN_TYPES = ['amortizing', 'fixed_principal', 'interest_only'];

/**
 * Deterministic seeded PRNG (mulberry32) so property suite is reproducible.
 */
function seeded(seed) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(rng, loanType) {
  const principal = Math.round((1000 + rng() * 499000) * 100) / 100;
  const annualRate = Math.round(rng() * 15 * 100) / 100; // 0-15% APR
  const termMonths = 1 + Math.floor(rng() * 360); // 1..360
  const paymentDay = 1 + Math.floor(rng() * 31);
  const year = 2000 + Math.floor(rng() * 40);
  const month = 1 + Math.floor(rng() * 12);
  const day = 1 + Math.floor(rng() * 28);
  const startDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    loan_type: loanType,
    loan_principal: principal,
    loan_annual_interest_rate: annualRate,
    loan_term_months: termMonths,
    loan_start_date: startDate,
    loan_payment_day: paymentDay,
  };
}

describe('property: loan schedule principal sum', () => {
  for (const loanType of LOAN_TYPES) {
    it(`${loanType}: sum(principal_amount) ≈ loan_principal within 1 cent across 200 random configs`, () => {
      const rng = seeded(0xC0FFEE ^ loanType.length);
      for (let i = 0; i < 200; i++) {
        const cfg = randomCase(rng, loanType);
        const { schedule } = generateLoanRepaymentSchedule(cfg);
        const sumPrincipal = schedule.reduce((acc, row) => acc + row.principal_amount, 0);
        const delta = Math.abs(sumPrincipal - cfg.loan_principal);
        expect(delta, `principal drift for ${loanType} cfg=${JSON.stringify(cfg)} sum=${sumPrincipal}`).toBeLessThanOrEqual(CENT);
      }
    });

    it(`${loanType}: final remaining_principal == 0 across 100 random configs`, () => {
      const rng = seeded(0xABCDEF ^ loanType.length);
      for (let i = 0; i < 100; i++) {
        const cfg = randomCase(rng, loanType);
        const { schedule } = generateLoanRepaymentSchedule(cfg);
        const last = schedule[schedule.length - 1];
        expect(last.remaining_principal).toBe(0);
      }
    });
  }

  it('edge: single-payment loan fully amortizes in one row', () => {
    for (const loanType of LOAN_TYPES) {
      const cfg = {
        loan_type: loanType,
        loan_principal: 1234.56,
        loan_annual_interest_rate: 5,
        loan_term_months: 1,
        loan_start_date: '2025-01-15',
        loan_payment_day: 15,
      };
      const { schedule } = generateLoanRepaymentSchedule(cfg);
      expect(schedule).toHaveLength(1);
      expect(schedule[0].remaining_principal).toBe(0);
      expect(Math.abs(schedule[0].principal_amount - cfg.loan_principal)).toBeLessThanOrEqual(CENT);
    }
  });

  it('edge: 0% APR amortizing equals equal principal installments', () => {
    const cfg = {
      loan_type: 'amortizing',
      loan_principal: 12000,
      loan_annual_interest_rate: 0,
      loan_term_months: 12,
      loan_start_date: '2025-01-01',
      loan_payment_day: 1,
    };
    const { schedule } = generateLoanRepaymentSchedule(cfg);
    const sum = schedule.reduce((a, r) => a + r.principal_amount, 0);
    expect(Math.abs(sum - 12000)).toBeLessThanOrEqual(CENT);
    for (const row of schedule) {
      expect(row.interest_amount).toBe(0);
    }
  });
});
