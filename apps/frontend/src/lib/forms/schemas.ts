/**
 * Shared Zod field schemas for the financial forms.
 *
 * Convention (adopted 2026-08-03, closing the "no Zod form validation"
 * finding): each financial form derives a Zod schema from these field
 * builders and runs `safeParse` inside its existing submit path. Issue
 * `message`s carry i18n KEYS, not English text — the form translates them at
 * display time (`t(issue.message)`) so the exact same humanized copy flows
 * through the exact same presentation paths as before (inline ARIA field
 * errors via `useFieldErrors`/`<FieldError>`, or the form's existing toast).
 * Nothing about when or where errors appear is decided here.
 *
 * Consumers today: AddTransactionDialog (+ addTransactionForm schema),
 * TransactionInfoDialog, the portfolio Add/Edit txn dialogs
 * (portfolioTxnSchema.ts), AddAccountDialog (accountFormSchema.ts), and
 * TaxProfileDialog (taxProfileSchema.ts). New forms should compose these
 * builders rather than hand-rolling `if (!value)` chains.
 */
import { z } from 'zod';
import { parseLocaleNumber } from '@/utils/currency';

/** Non-empty string field (mirrors a plain `!value` required check). */
export function requiredString(requiredKey: string) {
    return z.string().min(1, requiredKey);
}

/** String field that must be non-empty after trimming. */
export function requiredTrimmedString(requiredKey: string) {
    return z.string().refine((value) => value.trim().length > 0, { message: requiredKey });
}

/**
 * Required YYYY-MM-DD date string. The DatePicker/`<input type="date">`
 * controls only ever emit '' or a valid Y-M-D, so non-empty is the whole
 * contract — a format regex here would only invent an unreachable error.
 */
export function ymdDateString(requiredKey: string) {
    return z.string().min(1, requiredKey);
}

/**
 * Locale-formatted money string → number (EU "1.234,56" and US "1,234.56"
 * both accepted, per parseLocaleNumber). Checks run in order and stop at the
 * first failure so exactly one message is reported per field:
 * empty → `required`; unparseable/non-finite → `invalid`; and, when a `zero`
 * key is given, an exact 0 → `zero`.
 */
export function moneyAmount(keys: { required: string; invalid: string; zero?: string }) {
    return z.string().transform((value, ctx) => {
        if (!value) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: keys.required });
            return z.NEVER;
        }
        const parsed = parseLocaleNumber(value);
        if (!Number.isFinite(parsed)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: keys.invalid });
            return z.NEVER;
        }
        if (keys.zero !== undefined && parsed === 0) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: keys.zero });
            return z.NEVER;
        }
        return parsed;
    });
}

/**
 * Currency code field: trimmed and uppercased, falling back to `defaultCode`
 * when the input is empty (matches the account form's long-standing
 * `trim().toUpperCase() || "EUR"` normalization).
 */
export function currencyCode(defaultCode?: string) {
    return z.string().transform((value) => {
        const code = value.trim().toUpperCase();
        return code || (defaultCode ?? code);
    });
}

/**
 * Map a Zod error onto a `FieldErrorMap` for `useFieldErrors`, translating
 * each issue's i18n-key message. `pathToFieldId` maps schema keys to control
 * DOM ids (e.g. `transaction_date` → `tx_date`); only the first issue per
 * field is kept, matching the one-message-per-field contract.
 */
export function fieldErrorsFromZod(
    error: z.ZodError | undefined,
    pathToFieldId: Record<string, string>,
    translate: (key: string) => string,
): Record<string, string | undefined> {
    const map: Record<string, string | undefined> = {};
    if (!error) return map;
    for (const issue of error.issues) {
        const fieldId = pathToFieldId[String(issue.path[0] ?? '')];
        if (!fieldId || map[fieldId] !== undefined) continue;
        map[fieldId] = translate(issue.message);
    }
    return map;
}
