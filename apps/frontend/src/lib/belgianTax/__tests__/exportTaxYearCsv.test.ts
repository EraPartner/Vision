import { describe, expect, it } from "vitest";
import { computeBelgianPIT } from "../pit";
import { buildTaxYearCsv } from "../exportTaxYearCsv";
import { makeTaxProfile } from "./testProfile";

function buildCsv(
    overrides: Partial<Parameters<typeof buildTaxYearCsv>[0]> = {},
) {
    const profile = overrides.profile ?? makeTaxProfile();
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
});
