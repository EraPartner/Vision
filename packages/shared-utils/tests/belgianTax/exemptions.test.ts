import { describe, expect, test } from "vitest";
import { allocateExemptions, computeDependentSupplements } from "../../src/belgianTax/exemptions.ts";
import { getTaxTable } from "../../src/belgianTax/constants.ts";
import type { HouseholdDependents } from "../../src/belgianTax/householdTypes.ts";

const table = getTaxTable(2025);
const twoChildren: HouseholdDependents = { children: 2, otherPersons: 0 };

describe("dependent supplements (art. 132)", () => {
    test("two children IY 2025 → 5,110; disabled child counts twice", () => {
        expect(computeDependentSupplements(twoChildren, false, table).total).toBe(5_110);
        expect(
            computeDependentSupplements({ children: 1, childrenDisabled: 1, otherPersons: 0 }, false, table).children,
        ).toBe(5_110);
    });

    test("child-under-3 supplement is forfeited when childcare is deducted", () => {
        const deps = { children: 1, childrenUnder3: 1, otherPersons: 0 };
        expect(computeDependentSupplements(deps, false, table).childUnder3).toBe(740);
        expect(computeDependentSupplements(deps, true, table).childUnder3).toBe(0);
    });
});

describe("allocateExemptions", () => {
    test("each partner gets the basic amount and their own disability supplement", () => {
        const r = allocateExemptions({
            mode: "separate",
            partners: [
                { id: "A", isDisabled: false, taxableIncome: 40_000 },
                { id: "B", isDisabled: true, taxableIncome: 30_000 },
            ],
            dependents: { children: 0, otherPersons: 0 },
            childcareDeducted: false,
            table,
        });
        expect(r.allocations.A?.ownTotal).toBe(10_910);
        expect(r.allocations.B?.ownTotal).toBe(10_910 + 1_980);
    });

    test("joint: supplements go to the partner with the higher taxable income", () => {
        const run = (a: number, b: number) =>
            allocateExemptions({
                mode: "joint",
                partners: [
                    { id: "A", isDisabled: false, taxableIncome: a },
                    { id: "B", isDisabled: false, taxableIncome: b },
                ],
                dependents: twoChildren,
                childcareDeducted: false,
                table,
            });
        expect(run(60_000, 20_000).supplementPartnerId).toBe("A");
        expect(run(20_000, 60_000).supplementPartnerId).toBe("B");
        expect(run(20_000, 60_000).allocations.B?.dependentSupplements).toBe(5_110);
        expect(run(20_000, 60_000).allocations.A?.dependentSupplements).toBe(0);
    });

    test("separate: supplements go to the claimant", () => {
        const r = allocateExemptions({
            mode: "separate",
            partners: [
                { id: "A", isDisabled: false, taxableIncome: 60_000 },
                { id: "B", isDisabled: false, taxableIncome: 20_000 },
            ],
            dependents: { ...twoChildren, claimantPartnerId: "B" },
            childcareDeducted: false,
            table,
        });
        expect(r.supplementPartnerId).toBe("B");
    });

    test("joint: the unused balance of one spouse's tax-free sum moves to the other", () => {
        const r = allocateExemptions({
            mode: "joint",
            partners: [
                { id: "A", isDisabled: false, taxableIncome: 40_000 },
                { id: "B", isDisabled: false, taxableIncome: 4_000 },
            ],
            dependents: { children: 0, otherPersons: 0 },
            childcareDeducted: false,
            table,
        });
        expect(r.allocations.B).toMatchObject({ transferredOut: 6_910, total: 4_000, applied: 4_000 });
        expect(r.allocations.A).toMatchObject({ transferredIn: 6_910, total: 17_820, applied: 17_820 });
        expect(r.unusedExemption).toBe(0);
    });

    test("no balance transfer outside a joint assessment", () => {
        const r = allocateExemptions({
            mode: "separate",
            partners: [
                { id: "A", isDisabled: false, taxableIncome: 40_000 },
                { id: "B", isDisabled: false, taxableIncome: 4_000 },
            ],
            dependents: { children: 0, otherPersons: 0 },
            childcareDeducted: false,
            table,
        });
        expect(r.allocations.A?.transferredIn).toBe(0);
        expect(r.unusedExemption).toBe(6_910);
    });

    test("isolated-parent supplement: granted to a single taxpayer, refused with a partner", () => {
        const single = allocateExemptions({
            mode: "single",
            partners: [{ id: "A", isDisabled: false, isIsolatedParent: true, taxableIncome: 30_000 }],
            dependents: twoChildren,
            childcareDeducted: false,
            table,
        });
        expect(single.allocations.A?.isolatedParentSupplement).toBe(1_980);

        const run = (mode: "joint" | "separate") =>
            allocateExemptions({
                mode,
                partners: [
                    { id: "A", isDisabled: false, isIsolatedParent: true, taxableIncome: 30_000 },
                    { id: "B", isDisabled: false, taxableIncome: 30_000 },
                ],
                dependents: twoChildren,
                childcareDeducted: false,
                table,
            });
        expect(run("joint").allocations.A?.isolatedParentSupplement).toBe(0);
        expect(run("joint").issues).toContainEqual({
            code: "isolated_parent_supplement_not_granted",
            severity: "warning",
            partnerId: "A",
        });
        expect(run("separate").issues).toContainEqual({
            code: "isolated_parent_supplement_not_granted",
            severity: "needs_source",
            partnerId: "A",
        });
    });
});
