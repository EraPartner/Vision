import { describe, it, expect } from 'vitest';
import { generateLoanRepaymentSchedule } from '../src/services/calculations/loanSchedule.js';

const base = {
  loan_type: 'amortizing',
  loan_principal: 12000,
  loan_annual_interest_rate: 5,
  loan_term_months: 12,
};

describe('generateLoanRepaymentSchedule — first installment never precedes the loan start', () => {
  it('shifts the whole schedule one month when payment day falls before start day', () => {
    const r = generateLoanRepaymentSchedule({
      ...base,
      loan_start_date: '2026-06-20',
      loan_payment_day: 5,
    });
    // Without the shift the first due date was 2026-06-05 — before the loan exists.
    expect(r.schedule[0].due_date).toBe('2026-07-05');
    expect(r.first_due_date).toBe('2026-07-05');
    expect(r.schedule).toHaveLength(12);
  });

  it('keeps the start month when the payment day is on or after the start day', () => {
    const r = generateLoanRepaymentSchedule({
      ...base,
      loan_start_date: '2026-06-03',
      loan_payment_day: 5,
    });
    expect(r.schedule[0].due_date).toBe('2026-06-05');
    expect(r.first_due_date).toBe('2026-06-05');
  });
});
