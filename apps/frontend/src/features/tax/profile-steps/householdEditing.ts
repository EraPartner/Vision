/**
 * Pure household edits used by the tax profile sheet (ADR-200). Every helper returns a new
 * household and keeps it valid for `parseHouseholdV2`: activity ids stay unique, net amounts
 * only sit on `net_professional_amount`, partner references never dangle and expense choices
 * are dropped once no activity uses their category.
 */
import { forfaitCategoryOf } from "@/lib/belgianTax/forfaitCategory";
import type { useLanguage } from "@/stores/hydration/LanguageHydration";
import type {
    ActivityKind,
    BelgianTaxHouseholdV2,
    ForfaitCategory,
    HouseholdPartner,
    IncomeActivity,
    PartnerId,
    PartnerReductionInputs,
    RelationshipEventKind,
} from "@/lib/belgianTax/householdTypes";

export function findPartner(
    household: BelgianTaxHouseholdV2,
    id: PartnerId,
): HouseholdPartner | undefined {
    return household.partners.find((p) => p.id === id);
}

/** Replace partner `id` with `update(partner)`; unknown ids leave the household unchanged. */
export function updatePartner(
    household: BelgianTaxHouseholdV2,
    id: PartnerId,
    update: (partner: HouseholdPartner) => HouseholdPartner,
): BelgianTaxHouseholdV2 {
    return {
        ...household,
        partners: household.partners.map((p) => (p.id === id ? update(p) : p)),
    };
}

/** Forfait categories with an expense choice: every category used by a gross activity. */
export function expenseCategories(partner: HouseholdPartner): ForfaitCategory[] {
    const seen: ForfaitCategory[] = [];
    for (const activity of partner.activities) {
        if (activity.kind === "net_professional_amount") continue;
        const category = forfaitCategoryOf(activity.kind);
        if (!seen.includes(category)) seen.push(category);
    }
    return seen;
}

/** Drop expense choices of categories that no activity of the partner uses any more. */
function pruneExpenseChoices(partner: HouseholdPartner): HouseholdPartner {
    const used = new Set(partner.activities.map((a) => forfaitCategoryOf(a.kind)));
    const professionalExpenses = Object.fromEntries(
        Object.entries(partner.professionalExpenses).filter(([category]) =>
            used.has(category as ForfaitCategory),
        ),
    ) as HouseholdPartner["professionalExpenses"];
    return { ...partner, professionalExpenses };
}

/** Next free `act_<partner>_<n>` id in the household. */
export function nextActivityId(household: BelgianTaxHouseholdV2, partnerId: PartnerId): string {
    const ids = new Set(household.partners.flatMap((p) => p.activities.map((a) => a.id)));
    let n = 1;
    while (ids.has(`act_${partnerId}_${n}`)) n += 1;
    return `act_${partnerId}_${n}`;
}

export function addActivity(
    household: BelgianTaxHouseholdV2,
    partnerId: PartnerId,
    kind: ActivityKind = "employee",
): BelgianTaxHouseholdV2 {
    const activity: IncomeActivity =
        kind === "net_professional_amount"
            ? { id: nextActivityId(household, partnerId), kind, grossIncome: 0, netProfessionalIncome: 0 }
            : { id: nextActivityId(household, partnerId), kind, grossIncome: 0 };
    return updatePartner(household, partnerId, (p) => ({
        ...p,
        activities: [...p.activities, activity],
    }));
}

export function removeActivity(
    household: BelgianTaxHouseholdV2,
    partnerId: PartnerId,
    activityId: string,
): BelgianTaxHouseholdV2 {
    return updatePartner(household, partnerId, (p) =>
        pruneExpenseChoices({
            ...p,
            activities: p.activities.filter((a) => a.id !== activityId),
        }),
    );
}

/** Activity fields to change; an `undefined` value removes an optional field. */
export type ActivityPatch = {
    [K in Exclude<keyof IncomeActivity, "id">]?: IncomeActivity[K] | undefined;
};

/**
 * Patch one activity. A kind change keeps the amount the user sees in the amount field and drops
 * the pension type when the activity is no longer a pension.
 */
export function updateActivity(
    household: BelgianTaxHouseholdV2,
    partnerId: PartnerId,
    activityId: string,
    patch: ActivityPatch,
): BelgianTaxHouseholdV2 {
    return updatePartner(household, partnerId, (p) =>
        pruneExpenseChoices({
            ...p,
            activities: p.activities.map((a) => {
                if (a.id !== activityId) return a;
                const next = { ...a } as Record<string, unknown>;
                for (const [key, value] of Object.entries(patch)) {
                    if (value === undefined) delete next[key];
                    else next[key] = value;
                }
                if (patch.kind !== undefined && patch.kind !== a.kind) {
                    const wasNet = a.kind === "net_professional_amount";
                    const isNet = patch.kind === "net_professional_amount";
                    if (isNet && !wasNet) {
                        next.netProfessionalIncome = a.grossIncome;
                        next.grossIncome = 0;
                    } else if (wasNet && !isNet) {
                        next.grossIncome = a.netProfessionalIncome ?? 0;
                        delete next.netProfessionalIncome;
                    }
                    // The return line (Vak V) only exists for pensions.
                    if (patch.kind !== "pension") delete next.pensionKind;
                }
                return next as unknown as IncomeActivity;
            }),
        }),
    );
}

/** Amount the activity contributes: the net figure for a net amount, else the gross. */
export function activityAmount(activity: IncomeActivity): number {
    return activity.kind === "net_professional_amount"
        ? (activity.netProfessionalIncome ?? 0)
        : activity.grossIncome;
}

function emptyReductions(): PartnerReductionInputs {
    return {
        personalPensionContributions: 0,
        lifeInsurancePremiums: 0,
        charitableDonations: 0,
        childcareCosts: 0,
        medicalExpenses: 0,
    };
}

/** Add partner B with one employee activity and no deductions. */
export function addPartnerB(household: BelgianTaxHouseholdV2): BelgianTaxHouseholdV2 {
    if (findPartner(household, "B")) return household;
    const partner: HouseholdPartner = {
        id: "B",
        isDisabled: false,
        activities: [{ id: nextActivityId(household, "B"), kind: "employee", grossIncome: 0 }],
        professionalExpenses: {},
        unionDues: 0,
        otherTaxableIncome: 0,
        alimonyPaid: 0,
        reductions: emptyReductions(),
    };
    return { ...household, partners: [...household.partners, partner] };
}

/**
 * Remove partner B. Events naming B, B as dependants or own-home claimant, the death-year
 * election, the legacy joint assumption and a migrated v1 spouse-disability flag go with it; the
 * couple's other events are kept so
 * that adding the partner back restores them.
 */
export function removePartnerB(household: BelgianTaxHouseholdV2): BelgianTaxHouseholdV2 {
    if (!findPartner(household, "B")) return household;
    const {
        deathYearElection: _election,
        legacyAssumedJoint: _legacy,
        ...relationship
    } = household.relationship;
    const dependents = { ...household.dependents };
    if (dependents.claimantPartnerId === "B") dependents.claimantPartnerId = "A";
    const home = { ...household.home };
    if (home.mortgageCreditPartnerId === "B") home.mortgageCreditPartnerId = "A";
    delete home.mortgageSharePartnerB;
    const next: BelgianTaxHouseholdV2 = {
        ...household,
        partners: household.partners.filter((p) => p.id !== "B"),
        relationship: {
            ...relationship,
            events: relationship.events.filter((e) => e.partnerId !== "B"),
        },
        dependents,
        home,
    };
    if (household.migratedFrom) {
        next.migratedFrom = {
            ...household.migratedFrom,
            unmappedFields: household.migratedFrom.unmappedFields.filter(
                (f) => f.field !== "isSpouseDisabled",
            ),
        };
    }
    return next;
}

export function nextEventId(household: BelgianTaxHouseholdV2): string {
    const ids = new Set(household.relationship.events.map((e) => e.id));
    let n = 1;
    while (ids.has(`evt_${n}`)) n += 1;
    return `evt_${n}`;
}

/**
 * Add a relationship event dated `date`. A recorded event replaces the legacy joint
 * assumption of a migrated `married_joint` profile.
 */
export function addRelationshipEvent(
    household: BelgianTaxHouseholdV2,
    kind: RelationshipEventKind,
    date: string,
): BelgianTaxHouseholdV2 {
    const { legacyAssumedJoint: _legacy, ...relationship } = household.relationship;
    return {
        ...household,
        relationship: {
            ...relationship,
            events: [
                ...relationship.events,
                {
                    id: nextEventId(household),
                    kind,
                    date,
                    ...(kind === "death" ? { partnerId: "B" as const } : {}),
                },
            ],
        },
    };
}

export function updateRelationshipEvent(
    household: BelgianTaxHouseholdV2,
    eventId: string,
    patch: { kind?: RelationshipEventKind; date?: string; partnerId?: PartnerId },
): BelgianTaxHouseholdV2 {
    return {
        ...household,
        relationship: {
            ...household.relationship,
            events: household.relationship.events.map((event) => {
                if (event.id !== eventId) return event;
                const next = { ...event, ...patch };
                if (next.kind === "death") next.partnerId = next.partnerId ?? "B";
                else delete next.partnerId;
                return next;
            }),
        },
    };
}

export function removeRelationshipEvent(
    household: BelgianTaxHouseholdV2,
    eventId: string,
): BelgianTaxHouseholdV2 {
    return {
        ...household,
        relationship: {
            ...household.relationship,
            events: household.relationship.events.filter((e) => e.id !== eventId),
        },
    };
}

export type Translate = ReturnType<typeof useLanguage>["t"];

/** "You" / "Partner", or the partner's own display name when one is stored. */
export function partnerLabel(
    t: Translate,
    partner: Pick<HouseholdPartner, "id" | "displayName"> | PartnerId,
): string {
    const id = typeof partner === "string" ? partner : partner.id;
    const name = typeof partner === "string" ? undefined : partner.displayName;
    return name?.trim() || t(`tax.household.partner.${id}`);
}

/** The partner a step should show: `selected` while it exists, else partner A. */
export function resolvePartnerId(
    household: BelgianTaxHouseholdV2,
    selected: PartnerId,
): PartnerId {
    return household.partners.some((p) => p.id === selected) ? selected : "A";
}

/** The household without the deprecated `home.mortgageRegion` (ADR-202). */
export function withoutMortgageRegion(household: BelgianTaxHouseholdV2): BelgianTaxHouseholdV2 {
    if (household.home.mortgageRegion === undefined) return household;
    const { mortgageRegion: _dropped, ...home } = household.home;
    return { ...household, home };
}
