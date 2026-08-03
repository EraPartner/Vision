/**
 * Zod submit schema for AddAccountDialog (create + edit modes).
 *
 * Validates and normalizes the string fields of AccountFormValues; the
 * enum/boolean fields are Select/Switch-constrained and pass through the
 * dialog untouched (`{ ...form, ...parsed.data }`). Issue messages are i18n
 * keys (see lib/forms/schemas.ts) — though this dialog keeps its historical
 * presentation: a missing name blocks silently (the submit button is also
 * disabled on it), and the edit-only statement rule surfaces through the
 * dialog's existing expand-Advanced + toast path.
 */
import { z } from 'zod';
import { currencyCode } from '@/lib/forms/schemas';

export function accountFormSchema(mode: 'create' | 'edit') {
    return z
        .object({
            name: z.string().refine((value) => value.trim().length > 0, {
                message: 'validation.required',
            }),
            display_name: z.string(),
            institution: z.string(),
            currency: currencyCode('EUR'),
            // Kept raw: the truthiness rule below and the payload mapper both
            // read the untouched strings, exactly as before.
            statementBalance: z.string(),
            statementBalanceDate: z.string(),
        })
        .superRefine((values, ctx) => {
            // A statement balance is only meaningful with its as-of date
            // (ADR-094). Edit only — create no longer renders these fields.
            if (mode === 'edit' && values.statementBalance && !values.statementBalanceDate) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['statementBalanceDate'],
                    message: 'accounts.field.statementBalanceDate',
                });
            }
        })
        .transform((values) => ({
            ...values,
            name: values.name.trim(),
            display_name: values.display_name.trim(),
            institution: values.institution.trim(),
        }));
}
