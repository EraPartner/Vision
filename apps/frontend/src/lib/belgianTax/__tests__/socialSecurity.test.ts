import { describe, expect, it } from "vitest";
import { getTaxTable } from "../constants";
import {
    computeEmployeeSocialSecurity,
    computeSpecialSocialSecurityContribution,
} from "../socialSecurity";
import { makeTaxProfile } from "./testProfile";

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
