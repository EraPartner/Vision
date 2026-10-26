// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { ok, settingsWithBaselines } from "@/test/msw/handlers";
import { renderWithApp } from "@/test/renderWithApp";
import { apiClient } from "@/lib/api";
import { useSettingsStore } from "@/stores/settingsStore";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";
import { upgradeProfileV1ToHousehold } from "@/lib/belgianTax/householdMigration";
import { applyProfileV1PatchToHousehold } from "@/lib/belgianTax/householdRuntime";
import type { BelgianTaxHouseholdV2 } from "@/lib/belgianTax/householdTypes";
import { TaxProfileDialog } from "@/features/tax/TaxProfileDialog";
import { TAX_COMPUTE_DEBOUNCE_MS } from "@/hooks/useBelgianTaxComputation";
import { must } from "@/features/testing/must";

const API_BASE = "http://localhost:3002";

/** A configured one-partner household with one employee activity, as the v1 upgrade makes it. */
function singleHousehold(
    overrides: Partial<typeof DEFAULT_BELGIAN_TAX_PROFILE> = {},
): BelgianTaxHouseholdV2 {
    const { migratedFrom: _record, ...household } = upgradeProfileV1ToHousehold({
        ...DEFAULT_BELGIAN_TAX_PROFILE,
        profileConfigured: true,
        grossAnnualIncome: 50_000,
        personalPensionContributions: 1_020,
        pensionEligible: true,
        dependentChildren: 1,
        ...overrides,
    });
    return household;
}

function coupleHousehold(): BelgianTaxHouseholdV2 {
    const base = singleHousehold();
    return {
        ...base,
        partners: [
            ...base.partners,
            {
                id: "B",
                isDisabled: false,
                activities: [{ id: "act_B_1", kind: "employee", grossIncome: 30_000 }],
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
        relationship: {
            events: [{ id: "evt_1", kind: "marriage", date: "2015-06-01" }],
        },
    };
}

function serveHousehold(household: BelgianTaxHouseholdV2) {
    server.use(
        http.get(`${API_BASE}/api/settings`, () =>
            ok(settingsWithBaselines({ belgian_tax_household_v2: household })),
        ),
    );
}

const storedHousehold = () => useSettingsStore.getState().household;

async function openSheet(user: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => expect(useSettingsStore.getState().isLoading).toBe(false));
    await user.click(await screen.findByRole("button", { name: /tax profile/i }));
}

const next = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: /^next$/i }));

describe("TaxProfileDialog household editing", () => {
    beforeEach(() => {
        vi.spyOn(apiClient, "saveSetting").mockResolvedValue(undefined as never);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("round-trips a one-partner, one-activity household unchanged through every step", async () => {
        const seeded = singleHousehold();
        serveHousehold(seeded);
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);
        await openSheet(user);

        await screen.findByText("Your household");
        await next(user);
        expect(await screen.findByLabelText(/gross annual income/i)).toHaveValue("50000");
        await next(user);
        await screen.findByText("Home & property");
        await next(user);
        await screen.findByText("Taxable income sources");
        await next(user);
        await screen.findByText("Exemptions & dependents");
        await next(user);
        await screen.findByText("Region & communal surcharge");
        await user.click(screen.getByRole("button", { name: /save/i }));

        await waitFor(() =>
            expect(screen.queryByRole("heading", { name: "Tax profile" })).not.toBeInTheDocument(),
        );
        expect(storedHousehold()).toEqual(seeded);
    });

    it("edits the activity amount exactly as the v1 gross-income patch would", async () => {
        const seeded = singleHousehold();
        serveHousehold(seeded);
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog initialStep="income" />);
        await openSheet(user);

        const gross = await screen.findByLabelText(/gross annual income/i);
        await user.clear(gross);
        await user.type(gross, "61000");

        expect(storedHousehold()).toEqual(
            applyProfileV1PatchToHousehold(seeded, { grossAnnualIncome: 61_000 }),
        );
        expect(useSettingsStore.getState().profile.grossAnnualIncome).toBe(61_000);
    });

    it("adds and removes an activity and keeps one expense choice per used category", async () => {
        const seeded = singleHousehold();
        serveHousehold(seeded);
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog initialStep="income" />);
        await openSheet(user);

        await user.click(await screen.findByRole("button", { name: /add activity/i }));
        expect(storedHousehold()?.partners[0]?.activities.map((a) => a.id)).toEqual([
            "act_A_1",
            "act_A_2",
        ]);
        await user.click(screen.getByRole("button", { name: "Remove activity 2" }));
        expect(storedHousehold()).toEqual(seeded);
    });

    it("toggles partner B and edits the partner's own activity", async () => {
        const seeded = singleHousehold();
        serveHousehold(seeded);
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);
        await openSheet(user);

        await user.click(await screen.findByRole("switch", { name: /I have a partner/ }));
        expect(storedHousehold()?.partners.map((p) => p.id)).toEqual(["A", "B"]);
        // Two partners without a marriage or legal cohabitation are assessed separately; the
        // server derives the assessment once the edit settles.
        expect(await screen.findByText("Separate")).toBeInTheDocument();
        expect(screen.getByText(/No marriage or legal cohabitation recorded/)).toBeInTheDocument();

        await next(user);
        await user.click(await screen.findByRole("radio", { name: "Partner" }));
        expect(await screen.findByText("Activities of Partner")).toBeInTheDocument();
        const gross = screen.getByLabelText(/gross annual income/i);
        await user.clear(gross);
        await user.type(gross, "20000");
        expect(storedHousehold()?.partners[1]?.activities[0]?.grossIncome).toBe(20_000);
        expect(storedHousehold()?.partners[0]?.activities[0]?.grossIncome).toBe(50_000);

        await user.click(screen.getByRole("radio", { name: "Household" }));
        await user.click(await screen.findByRole("switch", { name: /I have a partner/ }));
        expect(storedHousehold()).toEqual(seeded);
    });

    it("shows the derived joint assessment and records new relationship events", async () => {
        serveHousehold(coupleHousehold());
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);
        await openSheet(user);

        expect(await screen.findByText("Joint")).toBeInTheDocument();
        expect(screen.getByText(/one joint assessment/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /add event/i }));
        const events = storedHousehold()?.relationship.events ?? [];
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({ id: "evt_2", kind: "marriage" });

        const removeButtons = screen.getAllByRole("button", { name: "Remove Marriage" });
        expect(removeButtons).toHaveLength(2);
        await user.click(must(removeButtons[1]));
        expect(storedHousehold()?.relationship.events.map((e) => e.id)).toEqual(["evt_1"]);
    });

    it("a first event on a migrated joint household keeps the joint assessment", async () => {
        const { migratedFrom: _record, ...migrated } = upgradeProfileV1ToHousehold({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            profileConfigured: true,
            grossAnnualIncome: 50_000,
            filingStatus: "married_joint",
            spouseProfessionalIncome: 20_000,
        });
        expect(migrated.relationship).toEqual({ events: [], legacyAssumedJoint: true });
        serveHousehold(migrated);
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);
        await openSheet(user);

        expect(await screen.findByText("Joint")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /add event/i }));
        const stored = storedHousehold();
        expect(stored?.relationship.legacyAssumedJoint).toBeUndefined();
        expect(stored?.relationship.events).toEqual([
            { id: "evt_1", kind: "marriage", date: `${migrated.taxYear - 1}-01-01` },
        ]);
        // Still joint once the server has assessed the edited household.
        await new Promise((resolve) =>
            setTimeout(resolve, TAX_COMPUTE_DEBOUNCE_MS + 100),
        );
        await waitFor(() => expect(screen.getByText("Joint")).toBeInTheDocument());
        expect(screen.queryByText("Separate")).not.toBeInTheDocument();
    });

    it("edits dependants claimant and own-home claimant", async () => {
        serveHousehold(coupleHousehold());
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);
        await openSheet(user);

        const claimant = await screen.findByRole("combobox", { name: "Dependants" });
        await user.click(claimant);
        await user.click(await screen.findByRole("option", { name: "Partner" }));
        expect(storedHousehold()?.dependents.claimantPartnerId).toBe("B");

        await user.click(screen.getByRole("combobox", { name: "Home credit" }));
        await user.click(await screen.findByRole("option", { name: "Partner" }));
        expect(storedHousehold()?.home.mortgageCreditPartnerId).toBe("B");
    });

    it("disables the own-home claimant once partner B's share is entered", async () => {
        serveHousehold(coupleHousehold());
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);
        await openSheet(user);

        const picker = await screen.findByRole("combobox", { name: "Home credit" });
        expect(picker).toBeEnabled();
        await user.type(screen.getByLabelText(/partner B's share of the home loan/i), "100");
        expect(storedHousehold()?.home.mortgageSharePartnerB).toBe(100);
        expect(picker).toBeDisabled();
        expect(picker).toHaveTextContent("Partner");
        expect(picker).toHaveAccessibleDescription(/set by partner B's share/i);
    });

    it("edits service-voucher spending per partner", async () => {
        serveHousehold(coupleHousehold());
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog initialStep="exemptions" />);
        await openSheet(user);

        await user.click(await screen.findByRole("radio", { name: "Partner" }));
        const spend = await screen.findByLabelText(/service vouchers bought/i);
        await user.type(spend, "900");
        await user.click(screen.getByRole("switch", { name: /service vouchers eligible/i }));
        const b = storedHousehold()?.partners[1];
        expect(b?.reductions.serviceVoucherSpend).toBe(900);
        expect(b?.reductions.serviceVoucherEligible).toBe(true);
        expect(storedHousehold()?.partners[0]?.reductions.serviceVoucherSpend).toBeUndefined();
    });

    it("drops a stored mortgage region after one edit of the home step", async () => {
        serveHousehold(
            singleHousehold({
                region: "wallonia",
                mortgageRegion: "flanders",
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2017,
                mortgageInterestPaid: 3_000,
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog initialStep="home" />);
        await openSheet(user);
        await waitFor(() =>
            expect(storedHousehold()?.home).toMatchObject({
                mortgageRegion: "flanders",
            }),
        );

        await user.type(await screen.findByLabelText(/first year the chèque habitat/i), "2019");
        expect(storedHousehold()?.home.firstQualifyingYear).toBe(2019);
        expect(storedHousehold()?.home).not.toHaveProperty("mortgageRegion");
    });

    it("asks for the chèque habitat first qualifying year only for a Walloon home", async () => {
        serveHousehold(
            singleHousehold({
                region: "wallonia",
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2017,
                mortgageInterestPaid: 3_000,
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog initialStep="home" />);
        await openSheet(user);

        const field = await screen.findByLabelText(/first year the chèque habitat/i);
        await user.type(field, "2019");
        expect(storedHousehold()?.home.firstQualifyingYear).toBe(2019);
        await user.clear(field);
        expect(storedHousehold()?.home).not.toHaveProperty("firstQualifyingYear");

        // The household region decides the regime (ADR-202): there is no mortgage-region select.
        expect(
            screen.queryByRole("combobox", { name: /region at mortgage signing/i }),
        ).not.toBeInTheDocument();
    });

    it("asks for the woonbonus children at the loan start only for a Flemish loan before 2020", async () => {
        serveHousehold(
            singleHousehold({
                region: "flanders",
                mortgageIsPrimaryResidence: true,
                mortgageStartYear: 2018,
                mortgageInterestPaid: 3_000,
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog initialStep="home" />);
        await openSheet(user);

        const field = await screen.findByLabelText(/dependent children on 1 january after the loan year/i);
        await user.type(field, "3");
        expect(storedHousehold()?.home.woonbonusChildrenAtLoanStart).toBe(3);
        await user.clear(field);
        expect(storedHousehold()?.home).not.toHaveProperty("woonbonusChildrenAtLoanStart");

        // A loan signed in 2020 has no woonbonus, so no such field.
        const year = screen.getByLabelText(/mortgage start year/i);
        await user.clear(year);
        await user.type(year, "2020");
        expect(
            screen.queryByLabelText(/dependent children on 1 january after the loan year/i),
        ).not.toBeInTheDocument();
    });
});
