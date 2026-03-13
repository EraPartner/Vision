const EPSILON = 0.0000001;

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function addMonthsAtDay(baseDateStr, monthOffset, preferredDay) {
  const [year, month] = baseDateStr.split('-').map(Number);
  const firstOfTarget = new Date(year, month - 1 + monthOffset, 1);
  const lastDay = new Date(firstOfTarget.getFullYear(), firstOfTarget.getMonth() + 1, 0).getDate();
  const day = Math.max(1, Math.min(Number(preferredDay) || 1, lastDay));
  const result = new Date(firstOfTarget.getFullYear(), firstOfTarget.getMonth(), day, 0, 0, 0, 0);
  return result.toISOString().split('T')[0];
}

export function validateLoanConfig(config) {
  const errors = [];
  const principal = Number(config.loan_principal);
  const annualRate = Number(config.loan_annual_interest_rate ?? 0);
  const termMonths = Number(config.loan_term_months);
  const paymentDay = Number(config.loan_payment_day);
  const loanType = String(config.loan_type || '').trim();

  if (!loanType) errors.push('loan_type is required for loan planned transactions');
  if (!Number.isFinite(principal) || principal <= 0) errors.push('loan_principal must be a positive number');
  if (!Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100) errors.push('loan_annual_interest_rate must be between 0 and 100');
  // Limit maximum sensible loan length to 600 months (50 years) to avoid nonsense values
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 600) errors.push('loan_term_months must be an integer between 1 and 600');
  if (!config.loan_start_date || !/^\d{4}-\d{2}-\d{2}$/.test(config.loan_start_date)) errors.push('loan_start_date must be in YYYY-MM-DD format');
  if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31) errors.push('loan_payment_day must be an integer between 1 and 31');

  return {
    errors,
    normalized: {
      loan_type: loanType,
      loan_principal: principal,
      loan_annual_interest_rate: annualRate,
      loan_term_months: termMonths,
      loan_start_date: config.loan_start_date,
      loan_payment_day: paymentDay,
    },
  };
}

export function generateLoanRepaymentSchedule(config) {
  const { errors, normalized } = validateLoanConfig(config);
  if (errors.length > 0) {
    const err = new Error(`Invalid loan configuration: ${errors.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  const {
    loan_type: loanType,
    loan_principal: principal,
    loan_annual_interest_rate: annualRate,
    loan_term_months: termMonths,
    loan_start_date: startDate,
    loan_payment_day: paymentDay,
  } = normalized;

  const monthlyRate = annualRate / 100 / 12;
  let remaining = principal;
  const schedule = [];

  let regularPayment = 0;
  if (loanType === 'amortizing') {
    if (Math.abs(monthlyRate) < EPSILON) {
      regularPayment = principal / termMonths;
    } else {
      regularPayment = (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths));
    }
  } else if (loanType === 'fixed_principal') {
    regularPayment = principal / termMonths;
  } else if (loanType === 'interest_only') {
    regularPayment = principal * monthlyRate;
  } else {
    const err = new Error(`Unsupported loan_type '${loanType}'. Use amortizing, fixed_principal, or interest_only.`);
    err.statusCode = 400;
    throw err;
  }

  for (let i = 1; i <= termMonths; i++) {
    const dueDate = addMonthsAtDay(startDate, i - 1, paymentDay);
    const interestAmount = roundMoney(remaining * monthlyRate);
    let principalAmount = 0;
    let paymentAmount = 0;

    if (loanType === 'amortizing') {
      principalAmount = roundMoney(regularPayment - interestAmount);
      if (i === termMonths || principalAmount > remaining) {
        principalAmount = roundMoney(remaining);
      }
      paymentAmount = roundMoney(principalAmount + interestAmount);
    } else if (loanType === 'fixed_principal') {
      principalAmount = roundMoney(principal / termMonths);
      if (i === termMonths || principalAmount > remaining) {
        principalAmount = roundMoney(remaining);
      }
      paymentAmount = roundMoney(principalAmount + interestAmount);
    } else {
      principalAmount = i === termMonths ? roundMoney(remaining) : 0;
      paymentAmount = roundMoney(principalAmount + interestAmount);
    }

    remaining = roundMoney(Math.max(0, remaining - principalAmount));

    schedule.push({
      installment_number: i,
      due_date: dueDate,
      payment_amount: paymentAmount,
      principal_amount: principalAmount,
      interest_amount: interestAmount,
      remaining_principal: remaining,
    });
  }

  return {
    regular_payment_amount: roundMoney(regularPayment),
    first_due_date: schedule[0]?.due_date ?? null,
    schedule,
  };
}
