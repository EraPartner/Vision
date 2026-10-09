/**
 * Synthetic rows shaped exactly like node-postgres returns them (NUMERIC and
 * BIGINT as strings, DATE/TIMESTAMPTZ as `Date`), for tests that mock
 * `query()` under a repository whose reads are checked by
 * `src/database/rowContracts.ts`. Tests run in strict mode, so a fixture must
 * satisfy the row schema; pass `overrides` for the columns a test cares about.
 */
import type {
  AccountBalanceQueryRow,
  AccountRow,
  EnrichedTransactionRow,
  PlannedExecutionRow,
  PlannedTransactionListRow,
  SplitPaymentRow,
  TransactionSplitRow,
} from "../../src/types/rows.ts";

const CREATED = new Date("2026-01-01T00:00:00.000Z");

/** A `transactions` row with the list/detail join columns (no `tags`). */
export function txRow(
  overrides: Partial<Omit<EnrichedTransactionRow, "tags">> = {},
): Omit<EnrichedTransactionRow, "tags"> {
  return {
    id: 1,
    date: new Date(2026, 0, 15),
    amount: "-10.0000",
    currency: "EUR",
    balance: null,
    memo: null,
    comment: null,
    bank_account: null,
    account_id: null,
    recipient_id: null,
    recipient_bank_account_id: null,
    category_id: null,
    is_active: true,
    recipient_name: null,
    category_name: null,
    ...overrides,
  };
}

/** An `accounts` row as `accountRepository`'s COLUMNS list projects it. */
export function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 1,
    name: "Account",
    display_name: null,
    institution: null,
    currency: "EUR",
    type: "checking",
    liquidity_class: "liquid",
    spendable: true,
    in_net_worth: true,
    tax_wrapper: "none",
    owner: "me",
    multi_currency_cash: false,
    has_cash_sleeve: true,
    funding_account_id: null,
    is_active: true,
    closed_at: null,
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

/** An `accountRepository.getAll` row. */
export function accountBalanceRow(
  overrides: Partial<AccountBalanceQueryRow> = {},
): AccountBalanceQueryRow {
  return {
    ...accountRow(),
    balance_parts: null,
    has_transactions: false,
    anchor_date: null,
    post_anchor_count: null,
    statement_balances: [],
    ...overrides,
  };
}

/** A `planned_transactions` row with the `PLANNED_SELECT_FIELDS` join columns. */
export function plannedRow(
  overrides: Partial<PlannedTransactionListRow> = {},
): PlannedTransactionListRow {
  return {
    id: 1,
    planned_date: new Date(2026, 0, 15),
    amount: "-10.0000",
    currency: "EUR",
    memo: null,
    comment: null,
    url: null,
    recipient_id: null,
    category_id: null,
    is_recurring: false,
    recurrence_pattern: null,
    is_loan: false,
    loan_type: null,
    loan_principal: null,
    loan_annual_interest_rate: null,
    loan_term_months: null,
    loan_start_date: null,
    loan_payment_day: null,
    loan_regular_payment_amount: null,
    loan_first_payment_date: null,
    is_executed: false,
    last_executed_date: null,
    is_active: true,
    recipient_name: null,
    category_name: null,
    ...overrides,
  };
}

/** A `planned_transaction_executions` row. */
export function plannedExecutionRow(
  overrides: Partial<PlannedExecutionRow> = {},
): PlannedExecutionRow {
  return {
    id: 1,
    planned_transaction_id: 1,
    executed_transaction_id: 1,
    execution_date: new Date(2026, 0, 15),
    created_at: CREATED,
    ...overrides,
  };
}

/** A `transaction_splits` row as the joined read paths project it. */
export function splitRow(
  overrides: Partial<TransactionSplitRow> = {},
): TransactionSplitRow {
  return {
    id: 1,
    transaction_id: 1,
    recipient_id: 1,
    amount: "10.0000",
    note: null,
    is_settled: false,
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

/** A `split_payments` row. */
export function splitPaymentRow(
  overrides: Partial<SplitPaymentRow> = {},
): SplitPaymentRow {
  return {
    id: 1,
    split_id: 1,
    amount: "5.0000",
    paid_at: new Date(2026, 0, 15),
    note: null,
    created_at: CREATED,
    ...overrides,
  };
}
