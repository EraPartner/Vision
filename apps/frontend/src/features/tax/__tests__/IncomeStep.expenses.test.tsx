// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";
import { upgradeProfileV1ToHousehold } from "@/lib/belgianTax/householdMigration";
import type { BelgianTaxHouseholdV2 } from "@/lib/belgianTax/householdTypes";
import type { HouseholdUpdate } from "@/stores/belgianTaxStore";
import { addActivity } from "../profile-steps/householdEditing";
import { IncomeStep } from "../profile-steps/IncomeStep";

describe("IncomeStep expense choices", () => {
    it("keeps both of two expense changes made before a re-render", () => {
        const household = addActivity(
            upgradeProfileV1ToHousehold({ ...DEFAULT_BELGIAN_TAX_PROFILE, grossAnnualIncome: 40_000 }),
            "A",
            "self_employed_profits",
        );
        const updates: HouseholdUpdate[] = [];
        // The props never change, as when two updates are queued before React re-renders.
        renderWithApp(
            <IncomeStep
                household={household}
                updateHousehold={(update) => updates.push(update)}
                partnerId="A"
                onPartnerChange={() => undefined}
            />,
        );

        const actual = screen
            .getAllByRole("radio")
            .filter((radio) => radio.getAttribute("value") === "actual");
        expect(actual).toHaveLength(2);
        fireEvent.click(actual[0]!);
        fireEvent.click(actual[1]!);
        expect(updates).toHaveLength(2);

        const result = updates.reduce<BelgianTaxHouseholdV2>(
            (h, update) => (typeof update === "function" ? update(h) : { ...h, ...update }),
            household,
        );
        expect(result.partners[0]!.professionalExpenses).toEqual({
            remuneration: { method: "actual", actualAmount: 0 },
            profits: { method: "actual", actualAmount: 0 },
        });
    });
});
