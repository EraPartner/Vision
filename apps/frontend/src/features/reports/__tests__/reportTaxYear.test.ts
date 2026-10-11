import { describe, expect, it } from "vitest";
import { reportTaxYear } from "@/features/reports/taxReportHousehold";

describe("reportTaxYear", () => {
    const today = "2026-10-11";

    it("returns the year of a single-year period", () => {
        expect(reportTaxYear({ kind: "year", year: 2024 }, today)).toBe(2024);
        expect(reportTaxYear({ kind: "ytd" }, today)).toBe(2026);
        expect(
            reportTaxYear({ kind: "custom", from: "2025-01-01", to: "2025-12-31" }, today),
        ).toBe(2025);
        expect(
            reportTaxYear({ kind: "custom", from: "2025-03-01", to: "2025-06-30" }, today),
        ).toBe(2025);
    });

    it("returns undefined for a period across calendar years", () => {
        expect(reportTaxYear({ kind: "rolling", months: 12 }, today)).toBeUndefined();
        expect(reportTaxYear({ kind: "rolling", months: 3 }, today)).toBeUndefined();
        expect(
            reportTaxYear({ kind: "custom", from: "2024-07-01", to: "2025-06-30" }, today),
        ).toBeUndefined();
    });
});
