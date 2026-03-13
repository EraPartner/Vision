import { describe, it, expect } from 'vitest';
import { generateLoanRepaymentSchedule } from '../src/services/loanRepaymentService.js';

describe('loanRepaymentService', () => {
  it('generates amortizing loan schedule', () => {
    const result = generateLoanRepaymentSchedule({
      loan_type: 'amortizing',
      loan_principal: 12000,
      loan_annual_interest_rate: 6,
      loan_term_months: 12,
      loan_start_date: '2026-01-15',
      loan_payment_day: 15,
    });

    expect(result.schedule).toHaveLength(12);
    expect(result.first_due_date).toBe('2026-01-15');
    expect(result.schedule[0].payment_amount).toBeGreaterThan(1000);
    expect(result.schedule[11].remaining_principal).toBe(0);
  });

  it('generates fixed principal schedule', () => {
    const result = generateLoanRepaymentSchedule({
      loan_type: 'fixed_principal',
      loan_principal: 6000,
      loan_annual_interest_rate: 12,
      loan_term_months: 6,
      loan_start_date: '2026-02-10',
      loan_payment_day: 10,
    });

    expect(result.schedule).toHaveLength(6);
    expect(result.schedule[0].principal_amount).toBe(1000);
    expect(result.schedule[5].remaining_principal).toBe(0);
  });

  it('generates interest-only schedule with balloon payment', () => {
    const result = generateLoanRepaymentSchedule({
      loan_type: 'interest_only',
      loan_principal: 50000,
      loan_annual_interest_rate: 4.8,
      loan_term_months: 10,
      loan_start_date: '2026-03-05',
      loan_payment_day: 5,
    });

    expect(result.schedule).toHaveLength(10);
    expect(result.schedule[0].principal_amount).toBe(0);
    expect(result.schedule[9].principal_amount).toBe(50000);
    expect(result.schedule[9].remaining_principal).toBe(0);
  });

  it('throws for invalid loan config', () => {
    expect(() =>
      generateLoanRepaymentSchedule({
        loan_type: 'amortizing',
        loan_principal: -1,
        loan_annual_interest_rate: 5,
        loan_term_months: 0,
        loan_start_date: 'bad',
        loan_payment_day: 40,
      })
    ).toThrow('Invalid loan configuration');
  });
});
