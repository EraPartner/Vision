import { describe, expect, it } from "vitest";
import { buildTaxYearCsv } from "../exportTaxYearCsv";
import { makeTaxProfile } from "./testProfile";
// Figures come from the server; the tests build them with the shared engine.
import { computeBelgianPIT } from "@vision/shared-utils/belgian-tax/pit";
import { computeHouseholdTax } from "@vision/shared-utils/belgian-tax/household";
import { activity, household, married, partner } from "./testHousehold";

function buildCsv(
    overrides: Partial<Parameters<typeof buildTaxYearCsv>[0]> = {},
) {
    // The browser projects a one-partner household as single.
    const profile = overrides.profile ?? makeTaxProfile({ filingStatus: "single" });
    return buildTaxYearCsv({
        year: 2025,
        profile,
        calculation: computeBelgianPIT(profile),
        currency: "EUR",
        isFiled: false,
        hasFrozenCalculation: false,
        generatedAt: "2026-05-12T08:00:00.000Z",
        ...overrides,
    });
}

describe("buildTaxYearCsv", () => {
    it("writes metadata and live, frozen, and filed statuses", () => {
        expect(buildCsv()).toContain("Status,live");
        expect(buildCsv({ hasFrozenCalculation: true })).toContain(
            "Status,frozen",
        );
        expect(
            buildCsv({ isFiled: true, hasFrozenCalculation: true }),
        ).toContain("Status,filed");
    });

    it("writes profile and calculation sections with the requested currency", () => {
        const csv = buildCsv({
            currency: "USD",
            profile: makeTaxProfile({
                grossAnnualIncome: 65_000,
                region: "brussels",
            }),
        });
        expect(csv).toContain("# Profile inputs");
        expect(csv).toContain("Gross annual income,65000");
        expect(csv).toContain("Region,brussels");
        expect(csv).toContain("# Calculation");
        expect(csv).toContain("Component,Amount (USD)");
        expect(csv).toContain("Total PIT,");
    });

    it("escapes metadata cells that contain commas", () => {
        expect(buildCsv({ generatedAt: "2026-05-12,08:00:00" })).toContain(
            'Generated at,"2026-05-12,08:00:00"',
        );
    });

    it("adds per-partner inputs, results and the quotient for two partners", () => {
        const h = married([activity("employee", 60_000)], [activity("employee", 10_000)]);
        h.partners[1]!.reductions.charitableDonations = 250;
        const result = computeHouseholdTax(h);
        const csv = buildCsv({ household: h, householdResult: result });
        const [a, b] = result.partners;
        expect(csv).toContain("# Per-partner inputs\nField,You,Partner,Household");
        expect(csv).toContain("Gross activity income,60000,10000,70000");
        expect(csv).toContain("Charitable donations,0,250,250");
        expect(csv).toContain("Component,You (EUR),Partner (EUR),Household (EUR)");
        expect(csv).toContain(
            `Total PIT,${a!.totalPIT.toFixed(2).replace(/\.?0+$/, "")},${b!.totalPIT
                .toFixed(2)
                .replace(/\.?0+$/, "")},`,
        );
        expect(csv).toContain("Assessment mode,joint");
        expect(csv).toContain("Marital quotient applied,true");
        expect(csv).toMatch(/Marital quotient transfer,[\d.]+,You,Partner/);
    });

    it("takes the filing status from the server's assessment of the year", () => {
        const h = married([activity("employee", 60_000)], [activity("employee", 10_000)]);
        const { filingStatus: _filingStatus, ...projected } = makeTaxProfile();
        expect(
            buildCsv({ profile: projected, household: h, householdResult: computeHouseholdTax(h) }),
        ).toContain("Filing status,married_joint");
        const separated = married([activity("employee", 60_000)], [activity("employee", 10_000)], {
            relationship: { events: [] },
        });
        expect(
            buildCsv({
                profile: projected,
                household: separated,
                householdResult: computeHouseholdTax(separated),
            }),
        ).toContain("Filing status,single");
        // A year frozen before its household result was stored: the browser does not decide.
        expect(buildCsv({ profile: projected })).toContain("Filing status,\n");
    });

    it("keeps a one-partner export unchanged", () => {
        const single = household([partner("A", [activity("employee", 60_000)])]);
        expect(
            buildCsv({ household: single, householdResult: computeHouseholdTax(single) }),
        ).toBe(buildCsv());
        expect(buildCsv({ household: null, householdResult: null })).toBe(buildCsv());
    });
});
