import { z } from "zod";
import { todayYmd } from "@/lib/timezone";
import {
    moneyAmount,
    requiredString,
    ymdDateString,
} from "@/lib/forms/schemas";
import type { NumberFormat } from "@/utils/currency";

/** What the sheet records: the sign of the amount follows from this. */
export type TransactionKind = "expense" | "income" | "transfer";

export type AddTransactionFormState = {
    kind: TransactionKind;
    transaction_date: string;
    bank_account: string;
    account_id: number | null;
    /** Transfer only: the receiving account. */
    to_bank_account: string;
    to_account_id: number | null;
    recipient_id: string;
    category_id: string;
    memo: string;
    /** Magnitude as typed; the kind decides the sign on submit. */
    amount: string;
    currency: string;
    comment: string;
};

export function createAddTransactionFormState(
    defaultCurrency?: string,
    kind: TransactionKind = "expense",
): AddTransactionFormState {
    return {
        kind,
        transaction_date: todayYmd(),
        bank_account: "",
        account_id: null,
        to_bank_account: "",
        to_account_id: null,
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
    account_id: "tx_bank",
    to_account_id: "tx_to_bank",
    recipient_id: "tx_recipient",
};

/** Visual order — decides which field gets focus on a blocked submit. */
export const ADD_TRANSACTION_FIELD_ORDER = [
    "tx_amount",
    "tx_recipient",
    "tx_bank",
    "tx_to_bank",
    "tx_date",
] as const;

/** Signed amount for the API: expenses leave, income and transfers-in arrive. */
export function signedAmount(kind: TransactionKind, magnitude: number): number {
    const abs = Math.abs(magnitude);
    return kind === "income" ? abs : -abs;
}

const accountId = (messageKey: string) =>
    z
        .number({ error: messageKey })
        .int(messageKey)
        .positive(messageKey);

/**
 * Submit-time validation for AddTransactionSheet. Issue messages are i18n
 * keys (see lib/forms/schemas.ts); the sheet translates them and feeds the
 * result through useFieldErrors, so each message lands on its own field:
 * - date and account required; recipient required unless the kind is a
 *   transfer, where the receiving account is required instead and must
 *   differ from the sending one;
 * - amount required, locale-parseable and non-zero. It is a magnitude: the
 *   kind supplies the sign, so a typed minus is ignored rather than flipping
 *   an expense into income.
 * Currency, category, memo, and comment pass through unvalidated.
 *
 * A discriminated union (not a refinement) carries the per-kind required
 * fields, so every missing field is reported in one pass: Zod skips
 * refinements while the base shape has issues, which would hide "recipient
 * required" behind "amount required".
 */
export const createAddTransactionSchema = (numberFormat: NumberFormat) => {
    const shared = {
        transaction_date: ymdDateString("validation.required"),
        amount: moneyAmount(
            {
                required: "validation.required",
                invalid: "addTxn.invalidAmount",
                zero: "addTxn.zeroAmount",
            },
            numberFormat,
        ),
        bank_account: z.string(),
        account_id: accountId("portfolio.move.selectAccount"),
        to_bank_account: z.string(),
        category_id: z.string(),
        memo: z.string(),
        currency: z.string(),
        comment: z.string(),
    };
    const withRecipient = {
        ...shared,
        to_account_id: z.number().int().positive().nullable(),
        recipient_id: requiredString("validation.required"),
    };
    return z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("expense"), ...withRecipient }),
        z.object({ kind: z.literal("income"), ...withRecipient }),
        z
            .object({
                kind: z.literal("transfer"),
                ...shared,
                to_account_id: accountId("portfolio.move.selectAccount"),
                recipient_id: z.string(),
            })
            .refine((form) => form.to_account_id !== form.account_id, {
                path: ["to_account_id"],
                message: "addTxn.transferSameAccount",
            }),
    ]);
};
