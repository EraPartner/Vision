import { parseDecimal } from "@/lib/decimal";
import type { Account, AccountCreate, AccountUpdate } from "@/types/api";
import type { AccountFormValues } from "./AddAccountDialog";

/**
 * Map AccountFormValues to the API payload. The empty-field sentinel differs
 * by verb, and that difference is deliberate:
 * - `create` (POST) omits empty optionals with `undefined` — omitted keys are
 *   simply not sent.
 * - `update` (PATCH) sends explicit `null` so the backend clears the stored
 *   value — `undefined` keys are dropped in JSON and would no-op the clear.
 */
export function toAccountPayload(values: AccountFormValues, mode: "create"): AccountCreate;
export function toAccountPayload(values: AccountFormValues, mode: "update"): AccountUpdate;
export function toAccountPayload(values: AccountFormValues, mode: "create" | "update"): AccountCreate | AccountUpdate {
    const empty = mode === "create" ? undefined : null;
    return {
        name: values.name,
        display_name: values.display_name || empty,
        institution: values.institution || empty,
        currency: values.currency,
        type: values.type,
        owner: values.owner,
        liquidity_class: values.liquidity_class,
        tax_wrapper: values.tax_wrapper,
        spendable: values.spendable,
        in_net_worth: values.in_net_worth,
        multi_currency_cash: values.multi_currency_cash,
        has_cash_sleeve: values.has_cash_sleeve,
        statement_balance: values.statementBalance ? parseDecimal(values.statementBalance) : empty,
        statement_balance_date: values.statementBalanceDate || empty,
    } as AccountCreate | AccountUpdate;
}

/** Map a stored Account onto the edit form's field values. */
export function accountToFormValues(account: Account): AccountFormValues {
    return {
        name: account.name,
        display_name: account.display_name ?? "",
        institution: account.institution ?? "",
        currency: account.currency,
        type: account.type,
        owner: account.owner,
        liquidity_class: account.liquidity_class,
        tax_wrapper: account.tax_wrapper,
        spendable: account.spendable,
        in_net_worth: account.in_net_worth,
        multi_currency_cash: account.multi_currency_cash,
        has_cash_sleeve: account.has_cash_sleeve,
        statementBalance: account.statement_balance != null ? String(account.statement_balance) : "",
        // The API emits YYYY-MM-DD. Keep the slice as defensive compatibility
        // with older cached payloads that may still contain an ISO timestamp.
        statementBalanceDate: account.statement_balance_date ? account.statement_balance_date.slice(0, 10) : "",
    };
}
