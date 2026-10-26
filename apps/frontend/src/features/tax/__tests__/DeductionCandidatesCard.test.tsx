// @vitest-environment jsdom
import React from "react";
import { beforeEach, expect, test, vi } from "vitest";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { AppSettingsProvider } from "@/stores/hydration/AppSettingsHydration";
import type { BelgianTaxProfile } from "@/lib/belgianTax";
import type { BelgianTaxHouseholdV2 } from "@/lib/belgianTax/householdTypes";
import type { DeductionCandidatesResponse } from "@/lib/api/info";
import { DISMISSED_DEDUCTION_CANDIDATES_STORAGE_KEY } from "@/lib/deductionCandidatesDismiss";
import DeductionCandidatesCard from "../DeductionCandidatesCard";
import { asCurrencyCode } from "@vision/types/brands";
import { must } from "@/test/must";

vi.mock("@/stores/hydration/LanguageHydration", () => ({
    LanguageProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    useLanguage: () => ({
        t: (key: string, vars?: Record<string, string | number>) => {
            const translations: Record<string, string> = {
                "tax.deductionCandidates.title":
                    "Suggested deductions from your transactions",
                "tax.deductionCandidates.unavailable":
                    "Could not load deduction suggestions. Try again.",
                "common.retry": "Retry",
                "tax.deductionCandidates.confirm": "Confirm",
                "tax.deductionCandidates.dismiss": "Dismiss",
                "tax.deductionCandidates.applied": "Applied",
                "tax.deductionCandidates.currentValue":
                    "Current profile value: {value}",
                "tax.deductionCandidates.fromCategories":
                    "from {count} categories",
                "tax.deductionCandidates.incompleteYearTitle":
                    "Use an incomplete total for {year}?",
                "tax.deductionCandidates.incompleteYearDescription":
                    "This tax year is not complete. Applying it replaces {currentValue} with {candidateValue}.",
                "tax.deductionCandidates.incompleteYearConfirm":
                    "I understand, apply total",
                "tax.deductionCandidates.type.lifeInsurance":
                    "Life insurance premiums",
                "tax.deductionCandidates.type.alimony": "Alimony paid",
                "tax.deductionCandidates.type.unionDues": "Union dues",
                "common.cancel": "Cancel",
                "tax.deductionCandidates.partnerShare":
                    "{partner}: {value} (now {current})",
                "tax.household.partner.A": "You",
                "tax.household.partner.B": "Partner",
            };
            let text = translations[key] ?? key;
            for (const [k, v] of Object.entries(vars ?? {})) {
                text = text.replace(`{${k}}`, String(v));
            }
            return text;
        },
        language: "en",
        setLanguage: () => {},
    }),
}));

vi.mock("sonner", () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const updateProfile = vi.fn();
const profile = {
    taxYear: 2025,
    lifeInsurancePremiums: 250,
    alimonyPaid: 0,
} as unknown as BelgianTaxProfile;

const ONE_PARTNER = { partners: [{ id: "A" }] };
const taxState = { household: ONE_PARTNER as object | null };
const updateHousehold = vi.fn();

vi.mock("@/contexts/BelgianTaxProfileContext", () => ({
    useBelgianTaxProfile: (selector: (state: object) => unknown) =>
        selector({
            profile,
            updateProfile,
            updateHousehold,
            household: taxState.household,
        }),
}));

const mockUseDeductionCandidates = vi.fn<(year: number) => unknown>();
vi.mock("@/hooks/useDeductionCandidates", () => ({
    useDeductionCandidates: (year: number) => mockUseDeductionCandidates(year),
}));

function makeResponse(
    overrides?: Partial<DeductionCandidatesResponse>,
): DeductionCandidatesResponse {
    return {
        year: 2025,
        from: "2025-01-01",
        to: "2025-12-31",
        currency: asCurrencyCode("EUR"),
        byDeductionType: [
            {
                deductionType: "lifeInsurance",
                total: 1200,
                categoryCount: 1,
                categories: [
                    { category: "Insurance: Life", total: 1200, count: 12 },
                ],
            },
            {
                deductionType: "alimony",
                total: 3600,
                categoryCount: 2,
                categories: [
                    { category: "Family: Alimony", total: 3000, count: 10 },
                    { category: "Family: Support", total: 600, count: 2 },
                ],
            },
            // Not in the deduction-type → profile-field map: must be skipped.
            {
                deductionType: "unknownType",
                total: 500,
                categoryCount: 1,
                categories: [{ category: "Misc", total: 500, count: 1 }],
            },
            // Mapped but non-positive total: must be skipped.
            {
                deductionType: "unionDues",
                total: 0,
                categoryCount: 1,
                categories: [{ category: "Work: Union", total: 0, count: 1 }],
            },
        ],
        ...overrides,
    };
}

function nthButton(name: string, index: number): HTMLElement {
    const button = screen.getAllByRole("button", { name })[index];
    if (!button) throw new Error(`expected a "${name}" button at ${index}`);
    return button;
}

function renderCard() {
    return render(
        <AppSettingsProvider>
            <DeductionCandidatesCard />
        </AppSettingsProvider>,
    );
}

beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    taxState.household = ONE_PARTNER;
    mockUseDeductionCandidates.mockReturnValue({
        data: makeResponse(),
        isLoading: false,
    });
});

// Mapped positive groups render with their type label, formatted transaction
// total, contributing categories, and the current profile value; unmapped and
// zero-total groups are skipped.
test("renders mapped groups with labels, totals, categories, and current value", () => {
    renderCard();

    expect(
        screen.getByText("Suggested deductions from your transactions"),
    ).toBeInTheDocument();
    expect(screen.getByText("Life insurance premiums")).toBeInTheDocument();
    expect(screen.getByText("Alimony paid")).toBeInTheDocument();
    // Default app settings: 'eu' number format (de-DE) with 2 decimals.
    expect(screen.getAllByText(/1\.200,00/).length).toBeGreaterThan(0); // lifeInsurance total
    expect(screen.getByText(/3\.600,00/)).toBeInTheDocument(); // alimony total
    expect(screen.getByText("Insurance: Life")).toBeInTheDocument();
    expect(screen.getByText("Family: Alimony")).toBeInTheDocument();
    expect(screen.getByText("from 2 categories")).toBeInTheDocument();
    // Current value of the Confirm target (lifeInsurancePremiums: 250).
    expect(
        screen.getByText(/Current profile value: 250,00/),
    ).toBeInTheDocument();
    // Skipped groups: unmapped type and total <= 0.
    expect(
        screen.queryByText("tax.deductionCandidates.type.unknownType"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Union dues")).not.toBeInTheDocument();
});

// Confirm on a type WITH an eligibility flag writes amount + flag in one update
// and swaps the buttons for an Applied badge.
test("confirm writes amount field and eligibility flag for lifeInsurance", () => {
    renderCard();

    // Groups render in response order: lifeInsurance first.
    fireEvent.click(nthButton("Confirm", 0));

    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile).toHaveBeenCalledWith({
        lifeInsurancePremiums: 1200,
        lifeInsuranceEligible: true,
    });
    expect(screen.getByText("Applied")).toBeInTheDocument();
});

// Before the household is hydrated (or when its engine failed to load) `updateProfile` is a
// no-op, so Confirm must not mark a candidate applied.
test("confirm is disabled and applies nothing without a hydrated household", () => {
    taxState.household = null;
    renderCard();

    const confirm = nthButton("Confirm", 0);
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);

    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.queryByText("Applied")).not.toBeInTheDocument();
});

// Confirm on a type WITHOUT an eligibility flag writes only the amount field.
test("confirm writes only the amount field for alimony", () => {
    renderCard();

    // alimony is the second rendered group.
    fireEvent.click(nthButton("Confirm", 1));

    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile).toHaveBeenCalledWith({ alimonyPaid: 3600 });
});

test("current-year candidate requires acknowledgement before replacing the annual value", async () => {
    const currentYear = new Date().getFullYear();
    mockUseDeductionCandidates.mockReturnValue({
        data: makeResponse({ year: currentYear }),
        isLoading: false,
    });
    renderCard();

    fireEvent.click(nthButton("Confirm", 0));

    const dialog = await screen.findByRole("alertdialog");
    expect(
        within(dialog).getByRole("heading", {
            name: `Use an incomplete total for ${currentYear}?`,
        }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/not complete/i)).toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();

    fireEvent.click(
        within(dialog).getByRole("button", {
            name: "I understand, apply total",
        }),
    );

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({
        lifeInsurancePremiums: 1200,
        lifeInsuranceEligible: true,
    });
    expect(screen.getByText("Applied")).toBeInTheDocument();
});

test("cancelling the current-year acknowledgement leaves the profile unchanged", async () => {
    mockUseDeductionCandidates.mockReturnValue({
        data: makeResponse({ year: new Date().getFullYear() }),
        isLoading: false,
    });
    renderCard();

    fireEvent.click(nthButton("Confirm", 1));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(updateProfile).not.toHaveBeenCalled();
    expect(screen.queryByText("Applied")).not.toBeInTheDocument();
});

// Dismiss hides the group and persists {year, deductionType} to localStorage.
test("dismiss removes the group and persists the dismissal", () => {
    renderCard();

    fireEvent.click(nthButton("Dismiss", 0));

    expect(
        screen.queryByText("Life insurance premiums"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Alimony paid")).toBeInTheDocument();
    const stored: unknown = JSON.parse(
        window.localStorage.getItem(
            DISMISSED_DEDUCTION_CANDIDATES_STORAGE_KEY,
        ) ?? "[]",
    );
    expect(stored).toEqual([{ year: 2025, deductionType: "lifeInsurance" }]);
});

// A persisted dismissal for the viewed year hides the group on mount, but the
// same dismissal for a DIFFERENT year does not.
test("persisted dismissals are year-scoped", () => {
    window.localStorage.setItem(
        DISMISSED_DEDUCTION_CANDIDATES_STORAGE_KEY,
        JSON.stringify([
            { year: 2025, deductionType: "lifeInsurance" },
            { year: 2024, deductionType: "alimony" },
        ]),
    );
    renderCard();

    expect(
        screen.queryByText("Life insurance premiums"),
    ).not.toBeInTheDocument(); // dismissed for 2025
    expect(screen.getByText("Alimony paid")).toBeInTheDocument(); // dismissed only for 2024
});

// No applicable groups → no card at all (no empty shell).
test("renders nothing when there are no applicable groups", () => {
    mockUseDeductionCandidates.mockReturnValue({
        data: makeResponse({ byDeductionType: [] }),
        isLoading: false,
    });
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
});

// Loading state also renders nothing.
test("renders nothing while loading", () => {
    mockUseDeductionCandidates.mockReturnValue({
        data: undefined,
        isLoading: true,
    });
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
});

test("shows a retryable error without offering cached amounts for confirmation", () => {
    const refetch = vi.fn();
    mockUseDeductionCandidates.mockReturnValue({
        data: makeResponse(),
        isLoading: false,
        isError: true,
        isFetching: false,
        refetch,
    });
    renderCard();

    expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load deduction suggestions. Try again.",
    );
    expect(
        screen.queryByRole("button", { name: "Confirm" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(updateProfile).not.toHaveBeenCalled();
});

test("disables retry while deduction suggestions are being fetched again", () => {
    mockUseDeductionCandidates.mockReturnValue({
        isError: true,
        isLoading: false,
        isFetching: true,
        refetch: vi.fn(),
    });
    renderCard();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
});

function twoPartnerHousehold(): BelgianTaxHouseholdV2 {
    const reductions = {
        personalPensionContributions: 0,
        lifeInsurancePremiums: 100,
        charitableDonations: 0,
        childcareCosts: 0,
        medicalExpenses: 0,
    };
    const partner = (id: "A" | "B") => ({
        id,
        isDisabled: false,
        activities: [],
        professionalExpenses: {},
        unionDues: 0,
        otherTaxableIncome: 0,
        alimonyPaid: 0,
        reductions: { ...reductions },
    });
    return {
        version: 2,
        taxYear: 2025,
        profileConfigured: true,
        region: "flanders",
        communalSurchargePercent: 7,
        partners: [partner("A"), partner("B")],
        relationship: { events: [] },
        dependents: { children: 0, otherPersons: 0 },
        home: { cadastralIncome: 0, mortgageInterestPaid: 0 },
    };
}

test("with two partners, shows each share and confirm writes it to that partner", () => {
    const household = twoPartnerHousehold();
    taxState.household = household;
    mockUseDeductionCandidates.mockReturnValue({
        data: makeResponse({
            byDeductionType: [
                {
                    deductionType: "lifeInsurance",
                    total: 1200,
                    byOwner: { me: 200, partner: 600, joint: 400 },
                    categoryCount: 1,
                    categories: [
                        { category: "Insurance: Life", total: 1200, count: 12 },
                    ],
                },
            ],
        }),
        isLoading: false,
    });
    renderCard();

    // me → you, partner → partner, joint split 50/50.
    expect(screen.getByText(/^You: .*400.*now.*100/)).toBeInTheDocument();
    expect(screen.getByText(/^Partner: .*800.*now.*100/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(updateProfile).not.toHaveBeenCalled();
    expect(updateHousehold).toHaveBeenCalledTimes(1);
    const updater = must(updateHousehold.mock.calls[0])[0] as (
        h: BelgianTaxHouseholdV2,
    ) => BelgianTaxHouseholdV2;
    const next = updater(household);
    expect(must(next.partners[0]).reductions).toMatchObject({
        lifeInsurancePremiums: 400,
        lifeInsuranceEligible: true,
    });
    expect(must(next.partners[1]).reductions).toMatchObject({
        lifeInsurancePremiums: 800,
        lifeInsuranceEligible: true,
    });
});

test("a one-partner household applies the whole total to the profile as before", () => {
    mockUseDeductionCandidates.mockReturnValue({
        data: makeResponse({
            byDeductionType: [
                {
                    deductionType: "alimony",
                    total: 3600,
                    byOwner: { me: 0, partner: 3600, joint: 0 },
                    categoryCount: 1,
                    categories: [
                        { category: "Family: Alimony", total: 3600, count: 1 },
                    ],
                },
            ],
        }),
        isLoading: false,
    });
    renderCard();
    expect(screen.queryByText(/^Partner:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(updateProfile).toHaveBeenCalledWith({ alimonyPaid: 3600 });
    expect(updateHousehold).not.toHaveBeenCalled();
});
