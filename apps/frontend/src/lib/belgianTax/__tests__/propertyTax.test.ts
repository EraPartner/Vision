import { describe, expect, it } from "vitest";
import { getTaxTable } from "../constants";
import { computePropertyTaxEstimate } from "../propertyTax";
import { makeTaxProfile } from "./testProfile";

const table = getTaxTable(2025);

describe("computePropertyTaxEstimate", () => {
    it("combines the primary home and additional residences by their own regions", () => {
        const mainOnly = computePropertyTaxEstimate(
            makeTaxProfile({ cadastralIncome: 1_000, region: "flanders" }),
            table,
        );
        const withAdditional = computePropertyTaxEstimate(
            makeTaxProfile({
                cadastralIncome: 1_000,
                region: "flanders",
                additionalResidences: [
                    {
                        label: "second",
                        cadastralIncome: 500,
                        region: "wallonia",
                    },
                ],
            }),
            table,
        );
        expect(mainOnly).toBeGreaterThan(0);
        expect(withAdditional).toBeGreaterThan(mainOnly);
    });

    it("honours a zero centimes override instead of replacing it with the regional default", () => {
        const defaultEstimate = computePropertyTaxEstimate(
            makeTaxProfile({ cadastralIncome: 1_000, region: "brussels" }),
            table,
        );
        const zeroOverride = computePropertyTaxEstimate(
            makeTaxProfile({
                cadastralIncome: 1_000,
                region: "brussels",
                cadastralCentimesOverride: 0,
            }),
            table,
        );
        expect(zeroOverride).toBeGreaterThan(0);
        expect(zeroOverride).toBeLessThan(defaultEstimate);
    });
});
