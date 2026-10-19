import { describe, expect, it } from "vitest";
import { getTaxTable } from "../../src/belgianTax/constants.ts";
import {
    computeEmployeeSocialSecurity,
    computeSpecialSocialSecurityContribution,
    estimateSelfEmployedContributions,
} from "../../src/belgianTax/socialSecurity.ts";
import { makeTaxProfile } from "./testProfile.ts";

const table = getTaxTable(2025);

describe("social security", () => {
    it("applies the employee and civil-servant rates only to supported employment types", () => {
        expect(
            computeEmployeeSocialSecurity(
                makeTaxProfile({ grossAnnualIncome: 40_000 }),
                table,
            ),
        ).toBeCloseTo(40_000 * table.employeeSSRate);
        expect(
            computeEmployeeSocialSecurity(
                makeTaxProfile({
                    employmentType: "civil_servant",
                    grossAnnualIncome: 40_000,
                }),
                table,
            ),
        ).toBeCloseTo(40_000 * table.civilServantSSRate);
        expect(
            computeEmployeeSocialSecurity(
                makeTaxProfile({ employmentType: "self_employed" }),
                table,
            ),
        ).toBe(0);
    });

    it("selects the filing-status CSSS table and rejects non-subject income", () => {
        const single = computeSpecialSocialSecurityContribution(
            makeTaxProfile(),
            40_000,
            table,
        );
        const joint = computeSpecialSocialSecurityContribution(
            makeTaxProfile({ filingStatus: "married_joint" }),
            40_000,
            table,
        );
        expect(single).toBeGreaterThan(0);
        expect(joint).toBeGreaterThan(0);
        expect(joint).not.toBe(single);
        expect(
            computeSpecialSocialSecurityContribution(
                makeTaxProfile({ employmentType: "self_employed" }),
                30_000,
                table,
            ),
        ).toBe(0);
    });
});

describe("self-employed contribution estimate (RD no. 38 art. 12 §1)", () => {
    it("carries the RSVZ thresholds per year (art. 14 fractions 656.54 / 662.28 / 676.50 over 142.75)", () => {
        expect(getTaxTable(2024).selfEmployedContributions).toEqual({
            rate1: 0.205,
            rate2: 0.1416,
            threshold1: 72_810.95,
            threshold2: 107_300.3,
            minimumIncome: 16_861.46,
        });
        expect(getTaxTable(2025).selfEmployedContributions.threshold1).toBe(73_447.52);
        expect(getTaxTable(2025).selfEmployedContributions.threshold2).toBe(108_238.4);
        expect(getTaxTable(2025).selfEmployedContributions.minimumIncome).toBe(17_008.88);
        expect(getTaxTable(2026).selfEmployedContributions.threshold1).toBe(75_024.54);
        expect(getTaxTable(2026).selfEmployedContributions.threshold2).toBe(110_562.42);
        expect(getTaxTable(2026).selfEmployedContributions.minimumIncome).toBe(17_374.08);
    });

    it("computes 20.50% on at least the minimum income", () => {
        const t = getTaxTable(2026);
        expect(estimateSelfEmployedContributions(0, t)).toBeCloseTo(17_374.08 * 0.205, 6);
        expect(estimateSelfEmployedContributions(10_000, t)).toBeCloseTo(17_374.08 * 0.205, 6);
        expect(estimateSelfEmployedContributions(-5, t)).toBeCloseTo(17_374.08 * 0.205, 6);
        expect(estimateSelfEmployedContributions(40_000, t)).toBeCloseTo(40_000 * 0.205, 6);
    });

    it("adds 14.16% between the thresholds and nothing above the upper threshold", () => {
        const t = getTaxTable(2026);
        const atFirst = 75_024.54 * 0.205;
        expect(estimateSelfEmployedContributions(75_024.54, t)).toBeCloseTo(atFirst, 6);
        expect(estimateSelfEmployedContributions(90_000, t)).toBeCloseTo(
            atFirst + (90_000 - 75_024.54) * 0.1416,
            6,
        );
        const max = atFirst + (110_562.42 - 75_024.54) * 0.1416;
        expect(estimateSelfEmployedContributions(110_562.42, t)).toBeCloseTo(max, 6);
        expect(estimateSelfEmployedContributions(500_000, t)).toBeCloseTo(max, 6);
    });

    it("uses the year table it is given", () => {
        expect(estimateSelfEmployedContributions(0, getTaxTable(2024))).toBeCloseTo(
            16_861.46 * 0.205,
            6,
        );
    });

    it("gives statutory civil servants 3.55% + 7.5% = 11.05%", () => {
        for (const year of [2024, 2025, 2026]) {
            expect(getTaxTable(year).civilServantSSRate).toBeCloseTo(0.0355 + 0.075, 10);
        }
    });
});
