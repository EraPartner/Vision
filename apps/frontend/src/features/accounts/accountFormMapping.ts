import type { Account, AccountCreate, AccountUpdate } from "@/types/api";
import type { NumberFormat } from "@/utils/currency";
import type { AccountFormValues } from "./AddAccountDialog";

/**
 * Map AccountFormValues to the API payload. The empty-field sentinel differs
 * by verb, and that difference is deliberate:
 * - `create` (POST) omits empty optionals with `undefined` — omitted keys are
 *   simply not sent.
 * - `update` (PATCH) sends explicit `null` so the backend clears the stored
 *   value — `undefined` keys are dropped in JSON and would no-op the clear.
 */
export function toAccountPayload(
    values: AccountFormValues,
    mode: "create",
    _numberFormat: NumberFormat,
): AccountCreate;
export function toAccountPayload(
    values: AccountFormValues,
    mode: "update",
    _numberFormat: NumberFormat,
): AccountUpdate;
export function toAccountPayload(
    values: AccountFormValues,
    mode: "create" | "update",
    _numberFormat: NumberFormat,
): AccountCreate | AccountUpdate {
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
    } as AccountCreate | AccountUpdate;
}

/**
 * Build the account metadata edit payload. Statement readings use their
 * dedicated per-currency endpoint and are never part of account PATCH.
 */
export function toAccountEditPayload(
    values: AccountFormValues,
    originalCurrency: string,
    numberFormat: NumberFormat,
): AccountUpdate {
    void originalCurrency;
    return toAccountPayload(values, "update", numberFormat);
}

/** Map a stored Account onto the edit form's field values. */
export function accountToFormValues(
    account: Account,
    _numberFormat: NumberFormat,
): AccountFormValues {
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
    };
}
