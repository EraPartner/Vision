// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";
import { upgradeProfileV1ToHousehold } from "@/lib/belgianTax/householdMigration";
import type { BelgianTaxHouseholdV2 } from "@/lib/belgianTax/householdTypes";
import type { HouseholdUpdate } from "@/stores/belgianTaxStore";
import { IncomeStep } from "../profile-steps/IncomeStep";
import { must } from "@/features/testing/must";

function renderStep(
    household: BelgianTaxHouseholdV2,
    updateHousehold: (update: HouseholdUpdate) => void = () => undefined,
) {
    renderWithApp(
        <IncomeStep
            household={household}
            updateHousehold={updateHousehold}
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
        must(must(household.partners[0]).activities[0]).pensionKind = "survivor_or_transition";
        renderStep(household);
        expect(screen.getByLabelText("Pension type")).toBeTruthy();
        expect(screen.getByText("Survivor's pension or transition allowance")).toBeTruthy();
        expect(screen.getByText(/codes 1229 and 1315/)).toBeTruthy();
    });

    it("shows Not entered for a pension without a type", () => {
        renderStep(
            upgradeProfileV1ToHousehold({
                ...DEFAULT_BELGIAN_TAX_PROFILE,
                employmentType: "retired",
                grossAnnualIncome: 18_000,
            }),
        );
        expect(screen.getByRole("combobox", { name: "Pension type" }).textContent).toBe("Not entered");
    });

    it("choosing Not entered clears the pension type", async () => {
        const household = upgradeProfileV1ToHousehold({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            employmentType: "retired",
            grossAnnualIncome: 18_000,
        });
        must(must(household.partners[0]).activities[0]).pensionKind = "statutory_from_legal_age";
        const updateHousehold = vi.fn<(update: HouseholdUpdate) => void>();
        renderStep(household, updateHousehold);
        const user = userEvent.setup();
        await user.click(screen.getByRole("combobox", { name: "Pension type" }));
        await user.click(await screen.findByRole("option", { name: "Not entered" }));
        expect(updateHousehold).toHaveBeenCalledTimes(1);
        const update = must(updateHousehold.mock.calls[0])[0];
        expect(typeof update).toBe("function");
        const next = (update as (h: BelgianTaxHouseholdV2) => BelgianTaxHouseholdV2)(household);
        expect(must(next.partners[0]).activities[0]).not.toHaveProperty("pensionKind");
    });
});
