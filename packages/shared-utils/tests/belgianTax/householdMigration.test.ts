import { describe, expect, test } from "vitest";
import {
    applyProfileV1PatchToHousehold,
    projectHouseholdToProfileV1,
    upgradeProfileV1ToHousehold,
    upgradeSnapshotsV1ToV2,
} from "../../src/belgianTax/householdMigration.ts";
import { filesJointly } from "../../src/belgianTax/assessment.ts";
import { parseHouseholdSnapshotsV2, parseHouseholdV2 } from "../../src/belgianTax/householdSchema.ts";
import type { BelgianTaxProfile } from "../../src/belgianTax/types.ts";
import { computeHouseholdTax, toBelgianTaxCalculation } from "../../src/belgianTax/household.ts";
import { computeBelgianPIT } from "../../src/belgianTax/pit.ts";
import { firstDifference } from "./householdParity.ts";
import { makeTaxProfile } from "./testProfile.ts";

const employee = makeTaxProfile({ filingStatus: "single", dependentChildren: 2, unionDues: 120 });
const joint = makeTaxProfile({
    filingStatus: "married_joint",
    spouseProfessionalIncome: 12_000,
    isSpouseDisabled: true,
});

describe("upgradeProfileV1ToHousehold", () => {
    test("maps an employee profile onto partner A", () => {
        const h = upgradeProfileV1ToHousehold(employee);
        expect(h.version).toBe(2);
        expect(h.partners).toHaveLength(1);
        const a = h.partners[0]!;
        expect(a.activities).toEqual([{ id: "act_A_1", kind: "employee", grossIncome: 50_000 }]);
        expect(a.professionalExpenses).toEqual({ remuneration: { method: "lump_sum", actualAmount: 0 } });
        expect(a.unionDues).toBe(120);
        expect(h.dependents).toMatchObject({ children: 2, otherPersons: 0, claimantPartnerId: "A" });
        expect(h.relationship).toEqual({ events: [] });
        expect(h.migratedFrom).toEqual({ fromVersion: 1, unmappedFields: [] });
    });

    test.each([
        ["self_employed", "profits", "self_employed_profits", "profits"],
        ["self_employed", "fees", "self_employed_fees", "fees"],
        ["retired", undefined, "pension", "none"],
        ["other", undefined, "other_professional", "none"],
        ["director", undefined, "director", "director"],
        ["civil_servant", undefined, "civil_servant", "remuneration"],
    ] as const)("%s (%s) → %s with expenses under %s", (employmentType, kind, activityKind, category) => {
        const profile = makeTaxProfile({
            employmentType,
            ...(kind ? { selfEmployedIncomeKind: kind } : {}),
            professionalExpenseMethod: "actual",
            actualProfessionalExpenses: 900,
        });
        const a = upgradeProfileV1ToHousehold(profile).partners[0]!;
        expect(a.activities[0]!.kind).toBe(activityKind);
        expect(a.professionalExpenses[category]).toEqual({ method: "actual", actualAmount: 900 });
    });

    test("married_joint creates partner B with the spouse's net income", () => {
        const h = upgradeProfileV1ToHousehold(joint);
        expect(h.partners[1]).toMatchObject({
            id: "B",
            isDisabled: true,
            activities: [
                { id: "act_B_1", kind: "net_professional_amount", grossIncome: 0, netProfessionalIncome: 12_000 },
            ],
        });
        expect(h.relationship).toEqual({ events: [], legacyAssumedJoint: true });
    });

    test("spouse fields on a single profile and unknown keys are kept as unmapped fields", () => {
        const profile = {
            ...makeTaxProfile({ filingStatus: "single", spouseProfessionalIncome: 9_000, isSpouseDisabled: true }),
            legacyNote: "x",
        } as BelgianTaxProfile;
        const h = upgradeProfileV1ToHousehold(profile);
        expect(h.partners).toHaveLength(1);
        expect(h.migratedFrom?.unmappedFields).toEqual([
            { field: "spouseProfessionalIncome", note: "spouse_income_without_joint_filing", value: 9_000 },
            { field: "isSpouseDisabled", note: "spouse_disability_without_joint_filing", value: true },
            { field: "legacyNote", note: "unknown_profile_field", value: "x" },
        ]);
    });

    test("is deterministic and idempotent", () => {
        const first = upgradeProfileV1ToHousehold(joint);
        expect(upgradeProfileV1ToHousehold(joint)).toEqual(first);
        expect(upgradeProfileV1ToHousehold(first)).toBe(first);
    });

    test("does not share references with the source profile", () => {
        const profile = makeTaxProfile({ additionalResidences: [{ cadastralIncome: 500 }] });
        const h = upgradeProfileV1ToHousehold(profile);
        h.home.additionalResidences![0]!.cadastralIncome = 1;
        expect(profile.additionalResidences![0]!.cadastralIncome).toBe(500);
    });

    test("the upgraded household passes the settings schema", () => {
        expect(parseHouseholdV2(upgradeProfileV1ToHousehold(joint)).ok).toBe(true);
        expect(parseHouseholdV2(upgradeProfileV1ToHousehold(employee)).ok).toBe(true);
    });
});

describe("upgradeSnapshotsV1ToV2", () => {
    test("upgrades every year and keeps v2 years untouched", () => {
        const v2 = upgradeProfileV1ToHousehold(joint);
        const result = upgradeSnapshotsV1ToV2({ 2024: makeTaxProfile({ taxYear: 2024 }), 2025: v2 } as never);
        expect(Object.keys(result)).toEqual(["2024", "2025"]);
        expect(result[2024]!.taxYear).toBe(2024);
        expect(result[2025]).toBe(v2);
        expect(parseHouseholdSnapshotsV2(result).ok).toBe(true);
        expect(upgradeSnapshotsV1ToV2(result)).toEqual(result);
    });

    test("a snapshot key must equal its household's taxYear", () => {
        const v2 = upgradeProfileV1ToHousehold(joint);
        const parsed = parseHouseholdSnapshotsV2({ 2024: { ...v2, taxYear: 2025 } });
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.issues[0]).toMatch(/^2024\.taxYear: must equal the snapshot key 2024$/);
    });
});

describe("projectHouseholdToProfileV1", () => {
    test.each([
        ["employee", employee],
        ["married joint", joint],
        ["single with spouse fields", makeTaxProfile({ filingStatus: "single", spouseProfessionalIncome: 9_000 })],
        [
            "self-employed fees with actual expenses",
            makeTaxProfile({
                filingStatus: "single",
                employmentType: "self_employed",
                selfEmployedIncomeKind: "fees",
                professionalExpenseMethod: "actual",
                actualProfessionalExpenses: 4_000,
            }),
        ],
    ])("round-trips a %s profile", (_label, profile) => {
        expect(projectHouseholdToProfileV1(upgradeProfileV1ToHousehold(profile), filesJointly)).toEqual(profile);
    });

    test("a single profile's spouse disability is not projected without partner B", () => {
        const profile = makeTaxProfile({ filingStatus: "single", isSpouseDisabled: true });
        const h = upgradeProfileV1ToHousehold(profile);
        expect(h.migratedFrom?.unmappedFields.map((f) => f.field)).toContain("isSpouseDisabled");
        const projected = projectHouseholdToProfileV1(h, filesJointly);
        expect(projected.isSpouseDisabled).toBe(false);
        // The projection agrees with the household engine, which has no partner B to disable.
        expect(
            firstDifference(
                computeBelgianPIT(projected),
                toBelgianTaxCalculation(computeHouseholdTax(h), h),
            ),
        ).toBeUndefined();
    });
});

describe("projectHouseholdToProfileV1 without a joint-filing check (browser)", () => {
    test("leaves the filing status of a household with partner B out", () => {
        const h = upgradeProfileV1ToHousehold(joint);
        const projected = projectHouseholdToProfileV1(h, undefined);
        expect(projected).not.toHaveProperty("filingStatus");
        expect({ ...projected, filingStatus: "married_joint" }).toEqual(
            projectHouseholdToProfileV1(h, filesJointly),
        );
    });

    test("projects a one-partner household as single", () => {
        expect(
            projectHouseholdToProfileV1(upgradeProfileV1ToHousehold(employee), undefined).filingStatus,
        ).toBe("single");
    });

    test("patches without the check like with it when the patch sets no spouse field", () => {
        const h = upgradeProfileV1ToHousehold(joint);
        const patch = { grossAnnualIncome: 61_000, dependentChildren: 1 };
        expect(applyProfileV1PatchToHousehold(h, patch, undefined)).toEqual(
            applyProfileV1PatchToHousehold(h, patch, filesJointly),
        );
    });
});

describe("applyProfileV1PatchToHousehold", () => {
    test.each<[string, BelgianTaxProfile, Partial<BelgianTaxProfile>]>([
        ["gross income", employee, { grossAnnualIncome: 61_000 }],
        ["employment type", employee, { employmentType: "self_employed", selfEmployedIncomeKind: "fees" }],
        ["expense method", employee, { professionalExpenseMethod: "actual", actualProfessionalExpenses: 2_500 }],
        ["dependants and home", employee, { dependentChildren: 3, cadastralIncome: 1_400 }],
        ["reductions", employee, { pensionEligible: true, personalPensionContributions: 1_000 }],
        ["spouse income", joint, { spouseProfessionalIncome: 20_000 }],
        ["start joint filing", employee, { filingStatus: "married_joint", spouseProfessionalIncome: 5_000 }],
        ["back to single", joint, { filingStatus: "single", spouseProfessionalIncome: 0, isSpouseDisabled: false }],
    ])("patching %s equals upgrading the patched profile", (_label, profile, patch) => {
        const patched = applyProfileV1PatchToHousehold(upgradeProfileV1ToHousehold(profile), patch, filesJointly);
        const expected = upgradeProfileV1ToHousehold({ ...profile, ...patch });
        expect(patched.partners).toEqual(expected.partners);
        expect(patched.dependents).toEqual(expected.dependents);
        expect(patched.home).toEqual(expected.home);
        expect(patched.relationship).toEqual(expected.relationship);
    });

    test("keeps household-only data", () => {
        const h = upgradeProfileV1ToHousehold(joint);
        h.relationship.events.push({ id: "evt_1", kind: "marriage", date: "2015-05-02" });
        h.partners[0]!.birthYear = 1980;
        h.partners[0]!.activities.push({ id: "act_A_2", kind: "self_employed_profits", grossIncome: 5_000 });
        const patched = applyProfileV1PatchToHousehold(h, { grossAnnualIncome: 70_000 }, filesJointly);
        expect(patched.relationship.events).toHaveLength(1);
        expect(patched.partners[0]!.birthYear).toBe(1980);
        expect(patched.partners[0]!.activities.map((a) => [a.id, a.grossIncome])).toEqual([
            ["act_A_1", 70_000],
            ["act_A_2", 5_000],
        ]);
        expect(h.partners[0]!.activities[0]!.grossIncome).toBe(50_000);
    });
});

describe("parseHouseholdV2", () => {
    test("rejects a v1 profile and reports paths", () => {
        const result = parseHouseholdV2(employee);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.issues.some((i) => i.startsWith("version"))).toBe(true);
    });

    test("accepts home.firstQualifyingYear, which the upgrade leaves undefined and v1 patches keep", () => {
        const h = upgradeProfileV1ToHousehold(employee);
        expect(h.home.firstQualifyingYear).toBeUndefined();
        const withYear = { ...h, home: { ...h.home, firstQualifyingYear: 2019 } };
        expect(parseHouseholdV2(withYear).ok).toBe(true);
        expect(parseHouseholdV2({ ...h, home: { ...h.home, firstQualifyingYear: 1800 } }).ok).toBe(false);
        expect(
            applyProfileV1PatchToHousehold(withYear, { mortgageStartYear: 2017 }, filesJointly).home.firstQualifyingYear,
        ).toBe(2019);
    });

    test("a v1 home edit drops the deprecated mortgageRegion and never writes it (ADR-202)", () => {
        const h = upgradeProfileV1ToHousehold({ ...employee, mortgageRegion: "wallonia" });
        expect(h.home.mortgageRegion).toBe("wallonia");
        expect(applyProfileV1PatchToHousehold(h, { dependentChildren: 1 }, filesJointly).home.mortgageRegion).toBe(
            "wallonia",
        );
        const edited = applyProfileV1PatchToHousehold(h, { mortgageInterestPaid: 2_500 }, filesJointly);
        expect(edited.home).not.toHaveProperty("mortgageRegion");
        expect(edited.home.mortgageInterestPaid).toBe(2_500);
        const plain = upgradeProfileV1ToHousehold(employee);
        expect(
            applyProfileV1PatchToHousehold(plain, { mortgageRegion: "brussels" }, filesJointly).home,
        ).not.toHaveProperty("mortgageRegion");
    });

    test("accepts home.woonbonusChildrenAtLoanStart, which the upgrade leaves undefined and v1 patches keep", () => {
        const h = upgradeProfileV1ToHousehold(employee);
        expect(h.home.woonbonusChildrenAtLoanStart).toBeUndefined();
        const withChildren = { ...h, home: { ...h.home, woonbonusChildrenAtLoanStart: 3 } };
        expect(parseHouseholdV2(withChildren).ok).toBe(true);
        expect(parseHouseholdV2({ ...h, home: { ...h.home, woonbonusChildrenAtLoanStart: 1.5 } }).ok).toBe(false);
        expect(parseHouseholdV2({ ...h, home: { ...h.home, woonbonusChildrenAtLoanStart: -1 } }).ok).toBe(false);
        expect(
            applyProfileV1PatchToHousehold(withChildren, { dependentChildren: 0 }, filesJointly).home.woonbonusChildrenAtLoanStart,
        ).toBe(3);
    });

    test("accepts pensionKind on a pension only; the upgrade leaves it undefined and a v1 kind edit drops it", () => {
        const h = upgradeProfileV1ToHousehold({ ...employee, employmentType: "retired" });
        const act = h.partners[0]!.activities[0]!;
        expect(act.kind).toBe("pension");
        expect(act).not.toHaveProperty("pensionKind");
        const typed = structuredClone(h);
        typed.partners[0]!.activities[0]!.pensionKind = "survivor_or_transition";
        expect(parseHouseholdV2(typed).ok).toBe(true);
        const wrong = structuredClone(typed);
        wrong.partners[0]!.activities[0]!.kind = "employee";
        const result = parseHouseholdV2(wrong);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.issues.some((i) => i.includes("pensionKind"))).toBe(true);
        const edited = applyProfileV1PatchToHousehold(typed, { employmentType: "employee" }, filesJointly);
        expect(edited.partners[0]!.activities[0]).not.toHaveProperty("pensionKind");
        expect(parseHouseholdV2(edited).ok).toBe(true);
        expect(
            applyProfileV1PatchToHousehold(typed, { grossAnnualIncome: 30_000 }, filesJointly).partners[0]!.activities[0]!.pensionKind,
        ).toBe("survivor_or_transition");
    });

    test("rejects dangling partner references", () => {
        const h = upgradeProfileV1ToHousehold(employee);
        const bad = { ...h, home: { ...h.home, mortgageCreditPartnerId: "B" } };
        expect(parseHouseholdV2(bad).ok).toBe(false);
    });
});
