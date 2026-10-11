// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { ok, settingsWithBaselines } from "@/test/msw/handlers";
import { renderWithApp } from "@/test/renderWithApp";
import { apiClient } from "@/lib/api";
import { useSettingsStore } from "@/stores/settingsStore";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";
import { upgradeProfileV1ToHousehold } from "@/lib/belgianTax/householdMigration";
import { computeHouseholdTax } from "@/lib/belgianTax/household";
import type { BelgianTaxHouseholdV2 } from "@/lib/belgianTax/householdTypes";
import { HouseholdBreakdownCard } from "./HouseholdBreakdownCard";

const API_BASE = "http://localhost:3002";

function single(): BelgianTaxHouseholdV2 {
    const { migratedFrom: _record, ...household } = upgradeProfileV1ToHousehold({
        ...DEFAULT_BELGIAN_TAX_PROFILE,
        profileConfigured: true,
        grossAnnualIncome: 60_000,
    });
    return household;
}

function married(): BelgianTaxHouseholdV2 {
    const base = single();
    return {
        ...base,
        partners: [
            ...base.partners,
            {
                id: "B",
                isDisabled: false,
                activities: [{ id: "act_B_1", kind: "employee", grossIncome: 0 }],
                professionalExpenses: {},
                unionDues: 0,
                otherTaxableIncome: 0,
                alimonyPaid: 0,
                reductions: {
                    personalPensionContributions: 0,
                    lifeInsurancePremiums: 0,
                    charitableDonations: 0,
                    childcareCosts: 0,
                    medicalExpenses: 0,
                },
            },
        ],
        relationship: { events: [{ id: "evt_1", kind: "marriage", date: "2015-06-01" }] },
    };
}

function serve(household: BelgianTaxHouseholdV2) {
    server.use(
        http.get(`${API_BASE}/api/settings`, () =>
            ok(settingsWithBaselines({ belgian_tax_household_v2: household })),
        ),
    );
}

/** Amount shown in a cell; the test locale formats as `9.167,33 €`. */
const amount = (text: string | null | undefined) =>
    Number((text ?? "").replace(/[^\d,]/g, "").replace(",", "."));

describe("HouseholdBreakdownCard", () => {
    beforeEach(() => {
        vi.spyOn(apiClient, "saveSetting").mockResolvedValue(undefined as never);
    });
    afterEach(() => vi.restoreAllMocks());

    it("renders nothing for a one-partner household", async () => {
        const household = single();
        serve(household);
        const { container } = renderWithApp(
            <HouseholdBreakdownCard viewedYear={household.taxYear} />,
        );
        await waitFor(() => expect(useSettingsStore.getState().isLoading).toBe(false));
        expect(container).toBeEmptyDOMElement();
    });

    it("shows per-partner columns, the joint assessment and the marital quotient", async () => {
        const household = married();
        const expected = computeHouseholdTax(household);
        expect(expected.quotient.applied).toBe(true);
        serve(household);
        const user = userEvent.setup();
        renderWithApp(<HouseholdBreakdownCard viewedYear={household.taxYear} />);

        await user.click(await screen.findByText("Per-partner breakdown"));
        const table = await screen.findByRole("table");
        const headers = within(table)
            .getAllByRole("columnheader")
            .map((h) => h.textContent);
        expect(headers).toEqual(["Component", "You", "Partner", "Household"]);

        const finalRow = within(table).getByRole("row", { name: /Income tax incl\. communal surcharge/ });
        const [a, b] = expected.partners;
        const cells = within(finalRow).getAllByRole("cell");
        expect(amount(cells[1]?.textContent)).toBeCloseTo(a!.totalPIT, 1);
        expect(amount(cells[2]?.textContent)).toBeCloseTo(b!.totalPIT, 1);
        expect(amount(cells[3]?.textContent)).toBeCloseTo(a!.totalPIT + b!.totalPIT, 1);

        const taxable = within(table).getByRole("row", { name: /Taxable income/ });
        // The quotient moves income to B, so B's taxable income is positive.
        expect(b!.taxableIncome).toBeGreaterThan(0);
        expect(amount(within(taxable).getAllByRole("cell")[2]?.textContent)).toBeCloseTo(
            b!.taxableIncome,
            1,
        );

        expect(screen.getByText("Joint")).toBeInTheDocument();
        const transfer = screen.getByText(/from You to Partner$/);
        expect(amount(transfer.textContent)).toBeCloseTo(expected.quotient.transfer, 1);
        expect(screen.getByText("Saving from the quotient")).toBeInTheDocument();
    });

    it("shows the tax-free sum charged and rows that add up to the final tax", async () => {
        // No marriage: separate assessment, and partner B has no income at all.
        const household = { ...married(), relationship: { events: [] } };
        const expected = computeHouseholdTax(household);
        expect(expected.assessment.mode).toBe("separate");
        const [a, b] = expected.partners;
        expect(b!.exemption.total).toBeGreaterThan(0);
        expect(b!.exemption.applied).toBe(0);
        serve(household);
        const user = userEvent.setup();
        renderWithApp(<HouseholdBreakdownCard viewedYear={household.taxYear} />);

        await user.click(await screen.findByText("Per-partner breakdown"));
        const table = await screen.findByRole("table");
        const cellsOf = (name: RegExp) =>
            within(within(table).getByRole("row", { name })).getAllByRole("cell");

        const taxFree = cellsOf(/^Tax-free sum/);
        expect(amount(taxFree[1]?.textContent)).toBeCloseTo(a!.exemption.applied, 1);
        expect(amount(taxFree[2]?.textContent)).toBe(0);
        expect(amount(taxFree[3]?.textContent)).toBeCloseTo(a!.exemption.applied, 1);

        const adjustment = cellsOf(/Regional factor and communal surcharge/);
        const adjustmentA = a!.totalPIT - (a!.pitAfterExemption - a!.reductionsApplied);
        expect(adjustmentA).not.toBe(0);
        expect(amount(adjustment[1]?.textContent)).toBeCloseTo(Math.abs(adjustmentA), 1);

        // Per column: tax after the tax-free sum − reductions ± adjustment = final tax.
        const signed = (text: string | null | undefined) =>
            (text ?? "").trim().startsWith("-") || (text ?? "").includes("−")
                ? -amount(text)
                : amount(text);
        const after = cellsOf(/^Tax after the tax-free sum/);
        const reductions = cellsOf(/^Tax reductions/);
        const final = cellsOf(/Income tax incl\. communal surcharge/);
        for (const column of [1, 2, 3]) {
            expect(
                amount(after[column]?.textContent) -
                    amount(reductions[column]?.textContent) +
                    signed(adjustment[column]?.textContent),
            ).toBeCloseTo(amount(final[column]?.textContent), 1);
        }
    });
});
