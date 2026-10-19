import { describe, expect, test } from "vitest";
import {
    DEFAULT_COMMUNAL_SURCHARGE,
    EARLIEST_TAX_YEAR,
    LATEST_TAX_YEAR,
    SUPPORTED_TAX_YEARS,
    getTaxTable,
    isApproximatedTaxYear,
} from "../../src/belgianTax/constants.ts";
import * as taxYears from "../../src/belgianTax/taxYears.ts";

describe("taxYears (the browser's copy of the table years)", () => {
    test("constants re-exports the same values", () => {
        expect(SUPPORTED_TAX_YEARS).toBe(taxYears.SUPPORTED_TAX_YEARS);
        expect(EARLIEST_TAX_YEAR).toBe(taxYears.EARLIEST_TAX_YEAR);
        expect(LATEST_TAX_YEAR).toBe(taxYears.LATEST_TAX_YEAR);
        expect(DEFAULT_COMMUNAL_SURCHARGE).toBe(taxYears.DEFAULT_COMMUNAL_SURCHARGE);
    });

    test("every supported year has its own table and no neighbouring year has one", () => {
        for (const year of SUPPORTED_TAX_YEARS) expect(isApproximatedTaxYear(year)).toBe(false);
        expect(isApproximatedTaxYear(EARLIEST_TAX_YEAR - 1)).toBe(true);
        expect(isApproximatedTaxYear(LATEST_TAX_YEAR + 1)).toBe(true);
        expect(SUPPORTED_TAX_YEARS[0]).toBe(EARLIEST_TAX_YEAR);
        expect(SUPPORTED_TAX_YEARS.at(-1)).toBe(LATEST_TAX_YEAR);
    });

    test("the default communal surcharges are the latest table's", () => {
        expect(DEFAULT_COMMUNAL_SURCHARGE).toEqual(
            getTaxTable(LATEST_TAX_YEAR).defaultCommunalSurcharge,
        );
    });
});
