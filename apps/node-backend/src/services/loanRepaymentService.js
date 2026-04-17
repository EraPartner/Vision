/**
 * Back-compat shim — canonical module is services/calculations/loanSchedule.js.
 * Kept so existing `services/loanRepaymentService.js` imports continue to work.
 * Remove once all callers switch to the new path.
 */
export { validateLoanConfig, generateLoanRepaymentSchedule } from './calculations/loanSchedule.js';
