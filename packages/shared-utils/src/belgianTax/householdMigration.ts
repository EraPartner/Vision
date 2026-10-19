/**
 * v1 single-profile ↔ v2 household mapping (ADR-200).
 *
 * The upgrade runs automatically when the frontend first loads a v1 profile; every function here
 * is pure, deterministic and idempotent (a v2 value passes through unchanged), so loading twice
 * or on two devices produces the same household.
 *
 * Mapping (v1 field → v2 location):
 *  - employmentType / selfEmployedIncomeKind / grossAnnualIncome → partner A activity `act_A_1`
 *    (self_employed → self_employed_profits or self_employed_fees; retired → pension;
 *    other → other_professional).
 *  - professionalExpenseMethod / actualProfessionalExpenses → A.professionalExpenses[category].
 *  - personal fields (disability, isolated parent, union dues, other income, alimony, reductions,
 *    dividends, savings) → partner A.
 *  - dependants → dependents (claimant A); cadastral and mortgage fields → home.
 *  - filingStatus `married_joint` → partner B with activity `act_B_1` of kind
 *    `net_professional_amount` = spouseProfessionalIncome, B.isDisabled = isSpouseDisabled,
 *    relationship.legacyAssumedJoint = true.
 *  - spouse fields on a `single` profile, and unknown keys → migratedFrom.unmappedFields.
 */

import { deriveAssessment } from "./assessment.ts";
import { forfaitCategoryOf } from "./forfaitCategory.ts";
import type {
    ActivityKind,
    BelgianTaxHouseholdSnapshotsV2,
    BelgianTaxHouseholdV2,
    HouseholdDependents,
    HouseholdHomeInputs,
    HouseholdPartner,
    IncomeActivity,
    PartnerReductionInputs,
    UnmappedField,
} from "./householdTypes.ts";
import type {
    BelgianTaxProfile,
    BelgianTaxProfileSnapshots,
    EmploymentType,
} from "./types.ts";

type ProfileKey = keyof BelgianTaxProfile;

const REDUCTION_KEYS = [
    "personalPensionContributions",
    "pensionScheme",
    "pensionEligible",
    "lifeInsurancePremiums",
    "lifeInsuranceEligible",
    "employeeGroupInsuranceContributions",
    "employeeGroupInsuranceEligible",
    "charitableDonations",
    "charitableDonationsEligible",
    "childcareCosts",
    "childcareEligibleDays",
    "childcareEligible",
    "domesticHelpCosts",
    "domesticHelpEligible",
    "serviceVoucherCount",
    "serviceVoucherSpend",
    "serviceVoucherEligible",
    "medicalExpenses",
] as const satisfies readonly (keyof PartnerReductionInputs)[];

const REQUIRED_REDUCTION_KEYS = [
    "personalPensionContributions",
    "lifeInsurancePremiums",
    "charitableDonations",
    "childcareCosts",
    "medicalExpenses",
] as const;

const HOME_KEYS = [
    "cadastralIncome",
    "cadastralCentimesOverride",
    "additionalResidences",
    "mortgageInterestPaid",
    "mortgageCapitalRepaid",
    "mortgageStartYear",
    // Deprecated (ADR-202): copied unchanged so the upgrade stays lossless and idempotent, but
    // the engines read the household region instead (special finance law art. 5/1 §2).
    "mortgageRegion",
    "mortgageIsPrimaryResidence",
] as const satisfies readonly ProfileKey[];

const DEPENDENT_KEY_MAP = {
    dependentChildren: "children",
    dependentChildrenUnder3: "childrenUnder3",
    dependentChildrenDisabled: "childrenDisabled",
    dependentOtherPersons: "otherPersons",
    dependentOtherPersonsDisabled: "otherPersonsDisabled",
} as const satisfies Partial<Record<ProfileKey, keyof HouseholdDependents>>;

const PARTNER_A_KEYS = [
    "isDisabled",
    "isIsolatedParent",
    "unionDues",
    "otherTaxableIncome",
    "alimonyPaid",
    "annualDividendIncome",
    "annualSavingsInterest",
] as const satisfies readonly (ProfileKey & keyof HouseholdPartner)[];

const HOUSEHOLD_KEYS = [
    "taxYear",
    "profileConfigured",
    "region",
    "communalSurchargePercent",
    "taxIncomeCategoryIds",
] as const satisfies readonly (ProfileKey & keyof BelgianTaxHouseholdV2)[];

const PRIMARY_ACTIVITY_KEYS = [
    "employmentType",
    "selfEmployedIncomeKind",
    "grossAnnualIncome",
    "professionalExpenseMethod",
    "actualProfessionalExpenses",
] as const satisfies readonly ProfileKey[];

const SPOUSE_KEYS = [
    "filingStatus",
    "spouseProfessionalIncome",
    "isSpouseDisabled",
] as const satisfies readonly ProfileKey[];

const KNOWN_V1_KEYS: ReadonlySet<string> = new Set<string>([
    ...REDUCTION_KEYS,
    ...HOME_KEYS,
    ...Object.keys(DEPENDENT_KEY_MAP),
    ...PARTNER_A_KEYS,
    ...HOUSEHOLD_KEYS,
    ...PRIMARY_ACTIVITY_KEYS,
    ...SPOUSE_KEYS,
]);

const PRIMARY_ACTIVITY_ID = "act_A_1";
const SPOUSE_ACTIVITY_ID = "act_B_1";

function activityKindFor(
    employmentType: EmploymentType,
    selfEmployedIncomeKind: BelgianTaxProfile["selfEmployedIncomeKind"],
): ActivityKind {
    switch (employmentType) {
        case "employee":
            return "employee";
        case "civil_servant":
            return "civil_servant";
        case "director":
            return "director";
        case "self_employed":
            return (selfEmployedIncomeKind ?? "profits") === "profits"
                ? "self_employed_profits"
                : "self_employed_fees";
        case "retired":
            return "pension";
        default:
            return "other_professional";
    }
}

function employmentTypeFor(kind: ActivityKind): {
    employmentType: EmploymentType;
    selfEmployedIncomeKind?: BelgianTaxProfile["selfEmployedIncomeKind"];
} {
    switch (kind) {
        case "employee":
            return { employmentType: "employee" };
        case "civil_servant":
            return { employmentType: "civil_servant" };
        case "director":
            return { employmentType: "director" };
        case "self_employed_profits":
            return { employmentType: "self_employed", selfEmployedIncomeKind: "profits" };
        case "self_employed_fees":
            return { employmentType: "self_employed", selfEmployedIncomeKind: "fees" };
        case "pension":
            return { employmentType: "retired" };
        default:
            return { employmentType: "other" };
    }
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Copy `keys` from `source` to `target`, skipping undefined values. */
function copyDefined<T extends object, K extends keyof T & string>(
    target: Partial<Record<K, unknown>>,
    source: T,
    keys: readonly K[],
): void {
    for (const key of keys) {
        const value = source[key];
        if (value !== undefined) target[key] = structuredClone(value);
    }
}

function reductionsFrom(profile: Partial<BelgianTaxProfile>): PartnerReductionInputs {
    const reductions: Record<string, unknown> = {};
    copyDefined(reductions, profile, REDUCTION_KEYS);
    for (const key of REQUIRED_REDUCTION_KEYS) {
        reductions[key] = num(reductions[key]);
    }
    return reductions as PartnerReductionInputs;
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

function legacySpouse(profile: Partial<BelgianTaxProfile>): HouseholdPartner {
    return {
        id: "B",
        isDisabled: !!profile.isSpouseDisabled,
        activities: [
            {
                id: SPOUSE_ACTIVITY_ID,
                kind: "net_professional_amount",
                grossIncome: 0,
                netProfessionalIncome: num(profile.spouseProfessionalIncome),
            },
        ],
        professionalExpenses: {},
        unionDues: 0,
        otherTaxableIncome: 0,
        alimonyPaid: 0,
        reductions: emptyReductions(),
    };
}

/** True when partner B holds nothing beyond the migrated `spouseProfessionalIncome` figure. */
function isLegacySpouse(partner: HouseholdPartner): boolean {
    return (
        partner.activities.every((a) => a.kind === "net_professional_amount") &&
        partner.otherTaxableIncome === 0 &&
        partner.alimonyPaid === 0 &&
        partner.unionDues === 0 &&
        partner.birthYear === undefined &&
        partner.displayName === undefined
    );
}

function isHouseholdV2(value: unknown): value is BelgianTaxHouseholdV2 {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as { version?: unknown }).version === 2
    );
}

/**
 * The v1 profile without its `null` fields. The v1 settings schema accepts `null` for any field,
 * but the household stores absent values as `undefined` (backend convention), so a stored `null`
 * means "not set".
 */
export function withoutNullFields<T extends object>(profile: T): T {
    return Object.fromEntries(
        Object.entries(profile).filter(([, value]) => value !== null),
    ) as T;
}

/**
 * Upgrade a v1 profile to a v2 household. A v2 value is returned unchanged; `null` v1 fields are
 * treated as absent.
 */
export function upgradeProfileV1ToHousehold(
    profile: BelgianTaxProfile | BelgianTaxHouseholdV2,
): BelgianTaxHouseholdV2 {
    if (isHouseholdV2(profile)) return profile;
    const p = withoutNullFields(profile);
    const unmappedFields: UnmappedField[] = [];

    const kind = activityKindFor(p.employmentType, p.selfEmployedIncomeKind);
    const primary: IncomeActivity = {
        id: PRIMARY_ACTIVITY_ID,
        kind,
        grossIncome: num(p.grossAnnualIncome),
    };
    const partnerA: HouseholdPartner = {
        id: "A",
        isDisabled: !!p.isDisabled,
        activities: [primary],
        professionalExpenses: {
            [forfaitCategoryOf(kind)]: {
                method: p.professionalExpenseMethod === "actual" ? "actual" : "lump_sum",
                actualAmount: num(p.actualProfessionalExpenses),
            },
        },
        unionDues: num(p.unionDues),
        otherTaxableIncome: num(p.otherTaxableIncome),
        alimonyPaid: num(p.alimonyPaid),
        reductions: reductionsFrom(p),
    };
    if (p.isIsolatedParent !== undefined) partnerA.isIsolatedParent = p.isIsolatedParent;
    if (p.annualDividendIncome !== undefined) partnerA.annualDividendIncome = p.annualDividendIncome;
    if (p.annualSavingsInterest !== undefined) partnerA.annualSavingsInterest = p.annualSavingsInterest;

    const dependents: HouseholdDependents = {
        children: num(p.dependentChildren),
        otherPersons: num(p.dependentOtherPersons),
        claimantPartnerId: "A",
    };
    if (p.dependentChildrenUnder3 !== undefined) dependents.childrenUnder3 = p.dependentChildrenUnder3;
    if (p.dependentChildrenDisabled !== undefined) dependents.childrenDisabled = p.dependentChildrenDisabled;
    if (p.dependentOtherPersonsDisabled !== undefined)
        dependents.otherPersonsDisabled = p.dependentOtherPersonsDisabled;

    const home: Record<string, unknown> = {};
    copyDefined(home, p, HOME_KEYS);
    home.cadastralIncome = num(home.cadastralIncome);
    home.mortgageInterestPaid = num(home.mortgageInterestPaid);

    const partners: HouseholdPartner[] = [partnerA];
    const joint = p.filingStatus === "married_joint";
    if (joint) {
        partners.push(legacySpouse(p));
    } else {
        if (num(p.spouseProfessionalIncome) > 0) {
            unmappedFields.push({
                field: "spouseProfessionalIncome",
                note: "spouse_income_without_joint_filing",
                value: p.spouseProfessionalIncome,
            });
        }
        if (p.isSpouseDisabled) {
            unmappedFields.push({
                field: "isSpouseDisabled",
                note: "spouse_disability_without_joint_filing",
                value: true,
            });
        }
    }
    for (const key of Object.keys(p).sort()) {
        if (KNOWN_V1_KEYS.has(key)) continue;
        unmappedFields.push({
            field: key,
            note: "unknown_profile_field",
            value: structuredClone((p as unknown as Record<string, unknown>)[key]),
        });
    }

    const household: BelgianTaxHouseholdV2 = {
        version: 2,
        taxYear: p.taxYear,
        profileConfigured: !!p.profileConfigured,
        region: p.region,
        communalSurchargePercent: num(p.communalSurchargePercent),
        partners,
        relationship: joint ? { events: [], legacyAssumedJoint: true } : { events: [] },
        dependents,
        home: home as HouseholdHomeInputs,
        migratedFrom: { fromVersion: 1, unmappedFields },
    };
    if (p.taxIncomeCategoryIds !== undefined)
        household.taxIncomeCategoryIds = [...p.taxIncomeCategoryIds];
    return household;
}

/** Upgrade every year of a v1 snapshot map. Years already holding v2 values are kept. */
export function upgradeSnapshotsV1ToV2(
    snapshots: BelgianTaxProfileSnapshots | BelgianTaxHouseholdSnapshotsV2,
): BelgianTaxHouseholdSnapshotsV2 {
    const result: BelgianTaxHouseholdSnapshotsV2 = {};
    const years = Object.keys(snapshots)
        .map(Number)
        .sort((a, b) => a - b);
    for (const year of years) {
        const value = (snapshots as Record<number, BelgianTaxProfile | BelgianTaxHouseholdV2>)[year];
        if (value !== undefined) result[year] = upgradeProfileV1ToHousehold(value);
    }
    return result;
}

function primaryActivity(partner: HouseholdPartner): IncomeActivity | undefined {
    return (
        partner.activities.find((a) => a.id === PRIMARY_ACTIVITY_ID) ??
        partner.activities.find((a) => a.kind !== "net_professional_amount") ??
        partner.activities[0]
    );
}

function activityAmount(activity: IncomeActivity): number {
    return activity.kind === "net_professional_amount"
        ? num(activity.netProfessionalIncome)
        : num(activity.grossIncome);
}

/**
 * Project a household onto the v1 profile shape for consumers that still read v1 fields. Lossy
 * when the household holds more than v1 can express: the primary activity of partner A sets the
 * employment type, A's activities are summed into `grossAnnualIncome`, and partner B is reduced
 * to `spouseProfessionalIncome` (sum of B's amounts). Unmapped v1 fields recorded by the upgrade
 * are restored.
 */
export function projectHouseholdToProfileV1(
    household: BelgianTaxHouseholdV2,
): BelgianTaxProfile {
    const restored: Record<string, unknown> = {};
    for (const field of household.migratedFrom?.unmappedFields ?? []) {
        if (field.value !== undefined) restored[field.field] = structuredClone(field.value);
    }
    const a = household.partners.find((p) => p.id === "A") ?? household.partners[0];
    const b = household.partners.find((p) => p.id === "B");
    const primary = a ? primaryActivity(a) : undefined;
    const kind: ActivityKind = primary?.kind ?? "employee";
    const employment = employmentTypeFor(kind);
    const expenseChoice = a?.professionalExpenses[forfaitCategoryOf(kind)];

    const profile: Record<string, unknown> = {
        ...restored,
        profileConfigured: household.profileConfigured,
        employmentType: employment.employmentType,
        grossAnnualIncome: a ? a.activities.reduce((s, x) => s + activityAmount(x), 0) : 0,
        professionalExpenseMethod: expenseChoice?.method ?? "lump_sum",
        actualProfessionalExpenses: expenseChoice?.actualAmount ?? 0,
        communalSurchargePercent: household.communalSurchargePercent,
        region: household.region,
        isDisabled: a?.isDisabled ?? false,
        // Without partner B no step can clear a migrated spouse flag, and the household engine
        // grants no spouse supplement, so the projection reports none.
        isSpouseDisabled: b ? b.isDisabled : false,
        unionDues: a?.unionDues ?? 0,
        otherTaxableIncome: a?.otherTaxableIncome ?? 0,
        alimonyPaid: a?.alimonyPaid ?? 0,
        taxYear: household.taxYear,
    };
    if (employment.selfEmployedIncomeKind !== undefined)
        profile.selfEmployedIncomeKind = employment.selfEmployedIncomeKind;
    if (a?.isIsolatedParent !== undefined) profile.isIsolatedParent = a.isIsolatedParent;
    if (a?.annualDividendIncome !== undefined) profile.annualDividendIncome = a.annualDividendIncome;
    if (a?.annualSavingsInterest !== undefined) profile.annualSavingsInterest = a.annualSavingsInterest;
    if (a) copyDefined(profile, a.reductions, REDUCTION_KEYS);
    for (const [v1Key, v2Key] of Object.entries(DEPENDENT_KEY_MAP)) {
        const value = household.dependents[v2Key];
        if (value !== undefined) profile[v1Key] = value;
    }
    copyDefined(profile, household.home, HOME_KEYS);
    if (household.taxIncomeCategoryIds !== undefined)
        profile.taxIncomeCategoryIds = [...household.taxIncomeCategoryIds];

    if (b) {
        const joint =
            household.relationship.legacyAssumedJoint === true &&
            household.relationship.events.length === 0
                ? true
                : deriveAssessment(household, household.taxYear).decision.mode === "joint";
        profile.filingStatus = joint ? "married_joint" : "single";
        profile.spouseProfessionalIncome = b.activities.reduce(
            (s, x) => s + activityAmount(x),
            0,
        );
    } else {
        profile.filingStatus = "single";
    }
    return profile as unknown as BelgianTaxProfile;
}

/**
 * Apply a v1 profile patch (as the v1 profile editor emits it) to a household, field by field.
 * Household-only data (relationship events, extra activities, partner B's own data, birth years)
 * is preserved. Unknown keys are ignored. The deprecated `mortgageRegion` (ADR-202) is never
 * written, and a patch that edits a home field drops a stored one, so the household region is
 * the only regime input after one edit of the home step.
 */
export function applyProfileV1PatchToHousehold(
    household: BelgianTaxHouseholdV2,
    patch: Partial<BelgianTaxProfile>,
): BelgianTaxHouseholdV2 {
    const next = structuredClone(household);
    const entries = Object.entries(patch) as [ProfileKey, unknown][];
    let a = next.partners.find((p) => p.id === "A");
    if (!a) {
        a = upgradeProfileV1ToHousehold(projectHouseholdToProfileV1(next)).partners[0] as HouseholdPartner;
        next.partners.unshift(a);
    }
    const partnerA = a;
    const set = (target: object, key: string, value: unknown) => {
        const record = target as Record<string, unknown>;
        if (value === undefined) delete record[key];
        else record[key] = structuredClone(value);
    };

    for (const [key, value] of entries) {
        if (key === "mortgageRegion") continue;
        if ((HOUSEHOLD_KEYS as readonly string[]).includes(key)) set(next, key, value);
        else if ((PARTNER_A_KEYS as readonly string[]).includes(key)) set(partnerA, key, value);
        else if ((REDUCTION_KEYS as readonly string[]).includes(key))
            set(partnerA.reductions, key, value);
        else if ((HOME_KEYS as readonly string[]).includes(key)) set(next.home, key, value);
        else if (key in DEPENDENT_KEY_MAP)
            set(next.dependents, DEPENDENT_KEY_MAP[key as keyof typeof DEPENDENT_KEY_MAP], value);
    }
    for (const key of REQUIRED_REDUCTION_KEYS) {
        partnerA.reductions[key] = num(partnerA.reductions[key]);
    }
    if (entries.some(([k]) => (HOME_KEYS as readonly string[]).includes(k)))
        delete next.home.mortgageRegion;

    const touches = (keys: readonly string[]) => entries.some(([k]) => keys.includes(k));
    if (touches(PRIMARY_ACTIVITY_KEYS)) {
        const merged = { ...projectHouseholdToProfileV1(household), ...patch };
        const kind = activityKindFor(merged.employmentType, merged.selfEmployedIncomeKind);
        let primary = primaryActivity(partnerA);
        if (!primary) {
            primary = { id: PRIMARY_ACTIVITY_ID, kind, grossIncome: 0 };
            partnerA.activities.unshift(primary);
        }
        if (primary.kind !== kind) {
            const oldCategory = forfaitCategoryOf(primary.kind);
            delete primary.netProfessionalIncome;
            if (kind !== "pension") delete primary.pensionKind;
            primary.kind = kind;
            // Drop the expense choice of a category no activity uses any more.
            if (!partnerA.activities.some((x) => forfaitCategoryOf(x.kind) === oldCategory))
                delete partnerA.professionalExpenses[oldCategory];
        }
        if (Object.hasOwn(patch, "grossAnnualIncome")) primary.grossIncome = num(merged.grossAnnualIncome);
        partnerA.professionalExpenses[forfaitCategoryOf(kind)] = {
            method: merged.professionalExpenseMethod === "actual" ? "actual" : "lump_sum",
            actualAmount: num(merged.actualProfessionalExpenses),
        };
    }

    if (touches(SPOUSE_KEYS)) {
        const merged = { ...projectHouseholdToProfileV1(household), ...patch };
        const bIndex = next.partners.findIndex((p) => p.id === "B");
        if (merged.filingStatus === "married_joint") {
            if (bIndex < 0) next.partners.push(legacySpouse(merged));
            const b = next.partners.find((p) => p.id === "B") as HouseholdPartner;
            if (Object.hasOwn(patch, "isSpouseDisabled")) b.isDisabled = !!merged.isSpouseDisabled;
            const netActivity = b.activities.find((x) => x.kind === "net_professional_amount");
            if (Object.hasOwn(patch, "spouseProfessionalIncome") && netActivity)
                netActivity.netProfessionalIncome = num(merged.spouseProfessionalIncome);
            if (next.relationship.events.length === 0) next.relationship.legacyAssumedJoint = true;
        } else if (Object.hasOwn(patch, "filingStatus")) {
            const b = next.partners[bIndex];
            if (b && isLegacySpouse(b)) next.partners.splice(bIndex, 1);
            delete next.relationship.legacyAssumedJoint;
        }
    }
    return next;
}
