/**
 * Zod step schemas for TaxProfileDialog.
 *
 * Only the income step has hard requirements: a positive gross annual income,
 * and — when the "actual expenses" deduction method is chosen — a positive
 * actual-expenses amount. The other steps have valid defaults for every
 * field, so they carry no schema. Issue messages are i18n keys (see
 * lib/forms/schemas.ts); the dialog translates `issues[0].message` into the
 * same single error toast as before, in the same rule order (gross income
 * first — the early return keeps one message per attempt).
 */
import { z } from 'zod';

// The profile stores plain numbers (parseDecimal output). `.catch(undefined)`
// makes any malformed value degrade to "missing", which the rules below then
// report as the required-field error — the same outcome the old truthiness
// checks produced.
const profileNumber = z.number().optional().catch(undefined);

export const taxProfileIncomeStepSchema = z
    .object({
        grossAnnualIncome: profileNumber,
        professionalExpenseMethod: z.string().optional().catch(undefined),
        actualProfessionalExpenses: profileNumber,
    })
    .superRefine((profile, ctx) => {
        if (!((profile.grossAnnualIncome ?? 0) > 0)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['grossAnnualIncome'],
                message: 'tax.profile.validation.grossIncomeRequired',
            });
            return;
        }
        if (
            profile.professionalExpenseMethod === 'actual' &&
            !((profile.actualProfessionalExpenses ?? 0) > 0)
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['actualProfessionalExpenses'],
                message: 'tax.profile.validation.actualExpensesRequired',
            });
        }
    });
