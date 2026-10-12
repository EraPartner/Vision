// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";
import { upgradeProfileV1ToHousehold } from "@/lib/belgianTax/householdMigration";
import type { BelgianTaxHouseholdV2 } from "@/lib/belgianTax/householdTypes";
import { IncomeStep } from "../profile-steps/IncomeStep";

function renderStep(household: BelgianTaxHouseholdV2) {
    renderWithApp(
        <IncomeStep
            household={household}
            updateHousehold={() => undefined}
            partnerId="A"
            onPartnerChange={() => undefined}
        />,
    );
}

describe("IncomeStep pension type", () => {
    it("asks for the return line (box V) of a pension only", () => {
        renderStep(
            upgradeProfileV1ToHousehold({ ...DEFAULT_BELGIAN_TAX_PROFILE, grossAnnualIncome: 40_000 }),
        );
        expect(screen.queryByLabelText("Pension type")).toBeNull();
    });

    it("shows the chosen type and its return code", () => {
        const household = upgradeProfileV1ToHousehold({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            employmentType: "retired",
            grossAnnualIncome: 18_000,
        });
        household.partners[0]!.activities[0]!.pensionKind = "survivor_or_transition";
        renderStep(household);
        expect(screen.getByLabelText("Pension type")).toBeTruthy();
        expect(screen.getByText("Survivor's pension or transition allowance")).toBeTruthy();
        expect(screen.getByText(/code 1229/)).toBeTruthy();
    });
});
