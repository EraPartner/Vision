/**
 * Zod step schema for TaxProfileDialog.
 *
 * Only the income step has hard requirements, checked on the household (ADR-200): partner A
 * has a positive income on at least one activity; every forfait category claimed with the
 * "actual expenses" method has a positive amount; an activity never ends before it starts.
 * The other steps have valid defaults for every field, so they carry no schema. Issue
 * messages are i18n keys (see lib/forms/schemas.ts); the dialog translates
 * `issues[0].message` into a single error toast, in the rule order above (the early returns
 * keep one message per attempt).
 */
import { z } from 'zod';
import { forfaitCategoryOf } from '@/lib/belgianTax/forfaitCategory';
import { ACTIVITY_KINDS } from '@/lib/belgianTax/householdTypes';
import { listGuard } from '@/lib/enumGuard';

const isActivityKind = listGuard(ACTIVITY_KINDS);

// The household stores plain numbers (parseDecimal output). `.catch(undefined)` makes any
// malformed value degrade to "missing", which the rules below then report.
const amount = z.number().optional().catch(undefined);
const text = z.string().optional().catch(undefined);

const activitySchema = z.object({
    kind: text,
    grossIncome: amount,
    netProfessionalIncome: amount,
    startDate: text,
    endDate: text,
});

const partnerSchema = z.object({
    id: text,
    activities: z.array(activitySchema).catch([]),
    professionalExpenses: z
        .record(
            z.string(),
            z.object({ method: text, actualAmount: amount }).catch({}),
        )
        .catch({}),
});

export const householdIncomeStepSchema = z
    .object({ partners: z.array(partnerSchema).catch([]) })
    .superRefine((household, ctx) => {
        const partnerA = household.partners.find((p) => p.id === 'A');
        const incomeA = (partnerA?.activities ?? []).reduce(
            (sum, a) =>
                sum +
                (a.kind === 'net_professional_amount'
                    ? (a.netProfessionalIncome ?? 0)
                    : (a.grossIncome ?? 0)),
            0,
        );
        if (!(incomeA > 0)) {
            ctx.addIssue({
                code: 'custom',
                path: ['partners', 'A', 'activities'],
                message: 'tax.profile.validation.grossIncomeRequired',
            });
            return;
        }
        for (const partner of household.partners) {
            const categories = new Set(
                partner.activities.flatMap((a) =>
                    isActivityKind(a.kind) && a.kind !== 'net_professional_amount'
                        ? [forfaitCategoryOf(a.kind)]
                        : [],
                ),
            );
            for (const category of categories) {
                const choice = partner.professionalExpenses[category];
                if (choice?.method === 'actual' && !((choice.actualAmount ?? 0) > 0)) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['partners', partner.id ?? '', 'professionalExpenses', category],
                        message: 'tax.profile.validation.actualExpensesRequired',
                    });
                    return;
                }
            }
        }
        for (const partner of household.partners) {
            for (const activity of partner.activities) {
                if (
                    activity.startDate &&
                    activity.endDate &&
                    activity.endDate < activity.startDate
                ) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['partners', partner.id ?? '', 'activities'],
                        message: 'tax.profile.validation.activityDatesOrder',
                    });
                    return;
                }
            }
        }
    });
