/**
 * Zod schemas for the v2 household settings values. They mirror the backend schemas in
 * apps/node-backend/src/routes/belgianTaxSettingsSchemas.ts (keys `belgian_tax_household_v2`
 * and `belgian_tax_household_snapshots_v2`); keep both in sync. Objects are loose so fields
 * added by later versions survive a round trip.
 */

import { z } from "zod";
import {
    ACTIVITY_KINDS,
    FORFAIT_CATEGORIES,
    RELATIONSHIP_EVENT_KINDS,
    type BelgianTaxHouseholdSnapshotsV2,
    type BelgianTaxHouseholdV2,
} from "./householdTypes";

const MONEY_MAX = 1e12;
const money = z.number().min(0).max(MONEY_MAX);
const count = z.number().int().min(0).max(1000);
const year = z.number().int().min(1900).max(2200);
const region = z.enum(["flanders", "wallonia", "brussels"]);
const partnerId = z.enum(["A", "B"]);
const activityId = z.string().regex(/^act_[A-Za-z0-9_-]{1,64}$/);
const isoDate = z.iso.date();

const activitySchema = z.looseObject({
    id: activityId,
    kind: z.enum(ACTIVITY_KINDS as [string, ...string[]]),
    label: z.string().max(200).optional(),
    grossIncome: money,
    netProfessionalIncome: money.optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    selfEmployedOccupation: z.enum(["main", "secondary"]).optional(),
    socialContributionsPaid: money.optional(),
    withholdingTax: money.optional(),
    prepayments: money.optional(),
    sourceRefs: z.array(z.string().max(200)).max(100).optional(),
});

const reductionsSchema = z.looseObject({
    personalPensionContributions: money,
    pensionScheme: z.enum(["1050", "1350"]).optional(),
    pensionEligible: z.boolean().optional(),
    lifeInsurancePremiums: money,
    lifeInsuranceEligible: z.boolean().optional(),
    employeeGroupInsuranceContributions: money.optional(),
    employeeGroupInsuranceEligible: z.boolean().optional(),
    charitableDonations: money,
    charitableDonationsEligible: z.boolean().optional(),
    childcareCosts: money,
    childcareEligibleDays: count.optional(),
    childcareEligible: z.boolean().optional(),
    domesticHelpCosts: money.optional(),
    domesticHelpEligible: z.boolean().optional(),
    serviceVoucherCount: count.optional(),
    serviceVoucherSpend: money.optional(),
    serviceVoucherEligible: z.boolean().optional(),
    medicalExpenses: money,
});

const expenseChoiceSchema = z.looseObject({
    method: z.enum(["lump_sum", "actual"]),
    actualAmount: money,
});

const partnerSchema = z.looseObject({
    id: partnerId,
    displayName: z.string().max(80).optional(),
    birthYear: year.optional(),
    isDisabled: z.boolean(),
    isIsolatedParent: z.boolean().optional(),
    activities: z.array(activitySchema).max(20),
    professionalExpenses: z.partialRecord(
        z.enum(FORFAIT_CATEGORIES as [string, ...string[]]),
        expenseChoiceSchema,
    ),
    unionDues: money,
    otherTaxableIncome: money,
    alimonyPaid: money,
    treatyExemptProfessionalIncome: money.optional(),
    reductions: reductionsSchema,
    annualDividendIncome: money.optional(),
    annualSavingsInterest: money.optional(),
});

const eventSchema = z.looseObject({
    id: z.string().min(1).max(64),
    kind: z.enum(RELATIONSHIP_EVENT_KINDS as [string, ...string[]]),
    date: isoDate,
    partnerId: partnerId.optional(),
});

const residenceSchema = z.looseObject({
    label: z.string().max(200).optional(),
    cadastralIncome: money,
    region: region.optional(),
    isOwnHome: z.boolean().optional(),
    centimesOverride: z.number().min(0).max(100000).optional(),
});

const homeSchema = z.looseObject({
    cadastralIncome: money,
    cadastralCentimesOverride: z.number().min(0).max(100000).optional(),
    additionalResidences: z.array(residenceSchema).max(50).optional(),
    mortgageInterestPaid: money,
    mortgageCapitalRepaid: money.optional(),
    mortgageStartYear: year.optional(),
    mortgageRegion: region.optional(),
    mortgageIsPrimaryResidence: z.boolean().optional(),
    mortgageCreditPartnerId: partnerId.optional(),
});

export const belgianTaxHouseholdV2Schema = z
    .looseObject({
        version: z.literal(2),
        taxYear: year,
        profileConfigured: z.boolean(),
        region,
        communalSurchargePercent: z.number().min(0).max(9),
        partners: z.array(partnerSchema).min(1).max(2),
        relationship: z.looseObject({
            events: z.array(eventSchema).max(50),
            deathYearElection: z.enum(["joint", "separate"]).optional(),
            legacyAssumedJoint: z.boolean().optional(),
        }),
        dependents: z.looseObject({
            children: count,
            childrenUnder3: count.optional(),
            childrenDisabled: count.optional(),
            otherPersons: count,
            otherPersonsDisabled: count.optional(),
            claimantPartnerId: partnerId.optional(),
        }),
        home: homeSchema,
        taxIncomeCategoryIds: z.array(z.number().int().min(1)).max(1000).optional(),
        migratedFrom: z
            .looseObject({
                fromVersion: z.literal(1),
                unmappedFields: z
                    .array(
                        z.looseObject({
                            field: z.string().max(100),
                            note: z.string().max(100),
                            value: z.unknown().optional(),
                        }),
                    )
                    .max(200),
            })
            .optional(),
    })
    .superRefine((household, ctx) => {
        const ids = household.partners.map((p) => p.id);
        if (new Set(ids).size !== ids.length) {
            ctx.addIssue({ code: "custom", path: ["partners"], message: "partner ids must be unique" });
        }
        if (!ids.includes("A")) {
            ctx.addIssue({ code: "custom", path: ["partners"], message: "partner A is required" });
        }
        const activityIds = new Set<string>();
        household.partners.forEach((partner, pi) => {
            partner.activities.forEach((activity, ai) => {
                if (activityIds.has(activity.id)) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["partners", pi, "activities", ai, "id"],
                        message: "activity ids must be unique",
                    });
                }
                activityIds.add(activity.id);
                if (
                    activity.netProfessionalIncome !== undefined &&
                    activity.kind !== "net_professional_amount"
                ) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["partners", pi, "activities", ai, "netProfessionalIncome"],
                        message: "netProfessionalIncome is only allowed on net_professional_amount",
                    });
                }
            });
        });
        const known = new Set(ids);
        household.relationship.events.forEach((event, ei) => {
            if (event.partnerId !== undefined && !known.has(event.partnerId)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["relationship", "events", ei, "partnerId"],
                    message: "unknown partner",
                });
            }
            if (event.kind === "death" && event.partnerId === undefined) {
                ctx.addIssue({
                    code: "custom",
                    path: ["relationship", "events", ei, "partnerId"],
                    message: "a death event names the deceased partner",
                });
            }
        });
        const claimant = household.dependents.claimantPartnerId;
        if (claimant !== undefined && !known.has(claimant)) {
            ctx.addIssue({
                code: "custom",
                path: ["dependents", "claimantPartnerId"],
                message: "unknown partner",
            });
        }
        const mortgagePartner = household.home.mortgageCreditPartnerId;
        if (mortgagePartner !== undefined && !known.has(mortgagePartner)) {
            ctx.addIssue({
                code: "custom",
                path: ["home", "mortgageCreditPartnerId"],
                message: "unknown partner",
            });
        }
    });

export const belgianTaxHouseholdSnapshotsV2Schema = z.record(
    z.string().regex(/^\d{4}$/),
    belgianTaxHouseholdV2Schema,
);

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function toResult<T>(parsed: { success: boolean; data?: unknown; error?: z.ZodError }): ParseResult<T> {
    if (parsed.success) return { ok: true, value: parsed.data as T };
    return {
        ok: false,
        issues: (parsed.error?.issues ?? []).map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        ),
    };
}

/** Validate a stored `belgian_tax_household_v2` value. */
export function parseHouseholdV2(value: unknown): ParseResult<BelgianTaxHouseholdV2> {
    return toResult(belgianTaxHouseholdV2Schema.safeParse(value));
}

/** Validate a stored `belgian_tax_household_snapshots_v2` value. */
export function parseHouseholdSnapshotsV2(
    value: unknown,
): ParseResult<BelgianTaxHouseholdSnapshotsV2> {
    return toResult(belgianTaxHouseholdSnapshotsV2Schema.safeParse(value));
}
