import { z } from 'zod';
import { todayYmd } from '@/lib/timezone';
import { moneyAmount, requiredString, requiredTrimmedString, ymdDateString } from '@/lib/forms/schemas';

export type AddTransactionFormState = {
  transaction_date: string;
  bank_account: string;
  recipient_id: string;
  category_id: string;
  memo: string;
  amount: string;
  currency: string;
  comment: string;
};

export function createAddTransactionFormState(defaultCurrency?: string): AddTransactionFormState {
  return {
    transaction_date: todayYmd(),
    bank_account: "",
    recipient_id: "",
    category_id: "",
    memo: "",
    amount: "",
    currency: defaultCurrency || "EUR",
    comment: "",
  };
}

/** Schema key → the control's DOM id, for the inline ARIA field errors. */
export const ADD_TRANSACTION_FIELD_IDS: Record<string, string> = {
  transaction_date: "tx_date",
  amount: "tx_amount",
  bank_account: "tx_bank",
  recipient_id: "tx_recipient",
};

/**
 * Submit-time validation for AddTransactionDialog. Issue messages are i18n
 * keys (see lib/forms/schemas.ts); the dialog translates them and feeds the
 * result through useFieldErrors, so the same messages appear on the same
 * fields as the previous hand-rolled checks:
 * - date/recipient required, bank account required (combobox has no native
 *   `required` message of its own);
 * - amount required, locale-parseable, and non-zero — the sign is the
 *   expense/income marker, so 0 is meaningless (the backend rejects it too).
 * Currency, category, memo, and comment pass through unvalidated, exactly as
 * before.
 */
export const addTransactionSchema = z.object({
  transaction_date: ymdDateString("validation.required"),
  amount: moneyAmount({
    required: "validation.required",
    invalid: "addTxn.invalidAmount",
    zero: "addTxn.zeroAmount",
  }),
  bank_account: requiredTrimmedString("portfolio.move.selectAccount"),
  recipient_id: requiredString("validation.required"),
  category_id: z.string(),
  memo: z.string(),
  currency: z.string(),
  comment: z.string(),
});
