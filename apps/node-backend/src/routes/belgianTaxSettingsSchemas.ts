/**
 * Settings-value schemas for the Belgian tax household model (ADR-200).
 *
 * `belgian_tax_household_v2` holds the live household; `belgian_tax_household_snapshots_v2`
 * maps an income year ("2025") to a frozen household. The shapes mirror
 * `BelgianTaxHouseholdV2` in apps/frontend/src/lib/belgianTax/householdTypes.ts and the
 * frontend schema in apps/frontend/src/lib/belgianTax/householdSchema.ts; keep the three in
 * sync. Objects are LOOSE like every other settings blob: unknown keys are stored, not stripped.
 */

import { z } from "zod";

const MONEY_MAX = 1e12;
const money = z.number().min(0).max(MONEY_MAX);
const count = z.number().int().min(0).max(1000);
const year = z.number().int().min(1900).max(2200);
const centimes = z.number().min(0).max(100000);
const region = z.enum(["flanders", "wallonia", "brussels"]);
const partnerId = z.enum(["A", "B"]);
const activityId = z.string().regex(/^act_[A-Za-z0-9_-]{1,64}$/);
const isoDate = z.iso.date();

const ACTIVITY_KINDS = [
  "employee",
  "civil_servant",
  "director",
  "self_employed_profits",
  "self_employed_fees",
  "helping_spouse",
  "pension",
  "other_professional",
  "net_professional_amount",
] as const;

const FORFAIT_CATEGORIES = [
  "remuneration",
  "profits",
  "director",
  "fees",
  "helping_spouse",
  "none",
] as const;

const RELATIONSHIP_EVENT_KINDS = [
  "marriage",
  "legal_cohabitation",
  "legal_cohabitation_ended",
  "factual_cohabitation_start",
  "factual_separation",
  "divorce",
  "death",
] as const;

const activitySchema = z.looseObject({
  id: activityId,
  kind: z.enum(ACTIVITY_KINDS),
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
  serviceVoucherEligible: z.boolean().optional(),
  medicalExpenses: money,
});

const partnerSchema = z.looseObject({
  id: partnerId,
  displayName: z.string().max(80).optional(),
  birthYear: year.optional(),
  isDisabled: z.boolean(),
  isIsolatedParent: z.boolean().optional(),
  activities: z.array(activitySchema).max(20),
  professionalExpenses: z.partialRecord(
    z.enum(FORFAIT_CATEGORIES),
    z.looseObject({
      method: z.enum(["lump_sum", "actual"]),
      actualAmount: money,
    }),
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
  kind: z.enum(RELATIONSHIP_EVENT_KINDS),
  date: isoDate,
  partnerId: partnerId.optional(),
});

const homeSchema = z.looseObject({
  cadastralIncome: money,
  cadastralCentimesOverride: centimes.optional(),
  additionalResidences: z
    .array(
      z.looseObject({
        label: z.string().max(200).optional(),
        cadastralIncome: money,
        region: region.optional(),
        isOwnHome: z.boolean().optional(),
        centimesOverride: centimes.optional(),
      }),
    )
    .max(50)
    .optional(),
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
    // % on federal PIT — Belgian municipalities levy 0-9% (same bound as the v1 profile).
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
    taxIncomeCategoryIds: z
      .array(z.number().int().min(1))
      .max(1000)
      .optional(),
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
      ctx.addIssue({
        code: "custom",
        path: ["partners"],
        message: "partner ids must be unique",
      });
    }
    if (!ids.includes("A")) {
      ctx.addIssue({
        code: "custom",
        path: ["partners"],
        message: "partner A is required",
      });
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
            message:
              "netProfessionalIncome is only allowed on net_professional_amount",
          });
        }
      });
    });
    const known = new Set<string>(ids);
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
  z.string().regex(/^\d{4}$/, "keys must be four-digit income years"),
  belgianTaxHouseholdV2Schema,
);
