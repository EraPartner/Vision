// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({
        t: (key: string, vars?: Record<string, string | number>) => {
            const dict: Record<string, string> = {
                "tax.yearSwitcher.trigger": "Switch tax year",
                "tax.yearSwitcher.label": "Tax year {year}",
                "tax.yearSwitcher.menuLabel": "Viewing year",
                "tax.yearSwitcher.currentBadge": "Current",
                "tax.yearSwitcher.snapshotBadge": "Saved",
                "tax.yearSwitcher.transactionsBadge": "Data only",
                "tax.yearSwitcher.createSnapshot": "Create profile for {year}",
            };
            let s = dict[key] ?? key;
            if (vars)
                for (const [k, v] of Object.entries(vars))
                    s = s.replaceAll(`{${k}}`, String(v));
            return s;
        },
        language: "en",
        setLanguage: () => {},
    }),
}));

vi.mock("@/contexts/BelgianTaxProfileContext", () => ({
    useBelgianTaxProfile: vi.fn(),
}));
vi.mock("@/hooks/useAvailableTaxYears", () => ({
    useAvailableTaxYears: vi.fn(),
}));

import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useAvailableTaxYears } from "@/hooks/useAvailableTaxYears";
import { TaxYearSwitcher } from "../TaxYearSwitcher";

const mockedProfile = vi.mocked(useBelgianTaxProfile);
const mockedYears = vi.mocked(useAvailableTaxYears);

function setup({
    viewedYear = 2026,
    liveYear = 2026,
    snapshotYears = [] as number[],
    years = [] as Array<{
        year: number;
        isCurrent: boolean;
        hasSnapshot: boolean;
        hasTransactions: boolean;
    }>,
} = {}) {
    const setViewedYear = vi.fn();
    const createSnapshotFromLive = vi.fn();
    mockedProfile.mockImplementation((selector) =>
        selector({
            viewedYear,
            setViewedYear,
            profile: { taxYear: liveYear },
            snapshots: Object.fromEntries(
                snapshotYears.map((year) => [year, { taxYear: year }]),
            ),
            createSnapshotFromLive,
        } as never),
    );
    mockedYears.mockReturnValue(
        years.map((y) => ({
            ...y,
            isFiled: false,
            hasFrozenCalculation: false,
        })),
    );
    return { setViewedYear, createSnapshotFromLive };
}

describe("TaxYearSwitcher", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("renders the trigger with the viewed year", () => {
        setup({
            viewedYear: 2024,
            years: [
                {
                    year: 2024,
                    isCurrent: false,
                    hasSnapshot: true,
                    hasTransactions: false,
                },
            ],
        });
        render(<TaxYearSwitcher />);
        expect(
            screen.getByRole("button", { name: /switch tax year/i }),
        ).toHaveTextContent("Tax year 2024");
    });

    it("lists every year from the hook when opened", async () => {
        setup({
            viewedYear: 2026,
            liveYear: 2026,
            years: [
                {
                    year: 2026,
                    isCurrent: true,
                    hasSnapshot: false,
                    hasTransactions: false,
                },
                {
                    year: 2025,
                    isCurrent: false,
                    hasSnapshot: true,
                    hasTransactions: false,
                },
                {
                    year: 2024,
                    isCurrent: false,
                    hasSnapshot: false,
                    hasTransactions: true,
                },
            ],
        });
        const user = userEvent.setup();
        render(<TaxYearSwitcher />);
        await user.click(
            screen.getByRole("button", { name: /switch tax year/i }),
        );
        const items = await screen.findAllByRole("menuitem");
        expect(items.map((el) => el.textContent)).toEqual([
            expect.stringContaining("2026"),
            expect.stringContaining("2025"),
            expect.stringContaining("2024"),
        ]);
        expect(screen.getByText("Current")).toBeInTheDocument();
        expect(screen.getByText("Saved")).toBeInTheDocument();
        expect(screen.getByText("Data only")).toBeInTheDocument();
    });

    it("calls setViewedYear when a year is selected", async () => {
        const { setViewedYear } = setup({
            viewedYear: 2026,
            liveYear: 2026,
            years: [
                {
                    year: 2026,
                    isCurrent: true,
                    hasSnapshot: false,
                    hasTransactions: false,
                },
                {
                    year: 2023,
                    isCurrent: false,
                    hasSnapshot: true,
                    hasTransactions: false,
                },
            ],
        });
        const user = userEvent.setup();
        render(<TaxYearSwitcher />);
        await user.click(
            screen.getByRole("button", { name: /switch tax year/i }),
        );
        await user.click(await screen.findByRole("menuitem", { name: /2023/ }));
        expect(setViewedYear).toHaveBeenCalledWith(2023);
    });

    it("shows the create-snapshot footer when viewing a year without a snapshot", async () => {
        const { createSnapshotFromLive } = setup({
            viewedYear: 2024,
            liveYear: 2026,
            snapshotYears: [],
            years: [
                {
                    year: 2026,
                    isCurrent: true,
                    hasSnapshot: false,
                    hasTransactions: false,
                },
                {
                    year: 2024,
                    isCurrent: false,
                    hasSnapshot: false,
                    hasTransactions: true,
                },
            ],
        });
        const user = userEvent.setup();
        render(<TaxYearSwitcher />);
        await user.click(
            screen.getByRole("button", { name: /switch tax year/i }),
        );
        const createBtn = await screen.findByRole("menuitem", {
            name: /create profile for 2024/i,
        });
        await user.click(createBtn);
        expect(createSnapshotFromLive).toHaveBeenCalledWith(2024);
    });

    it("hides the create-snapshot footer when a snapshot already exists", async () => {
        setup({
            viewedYear: 2024,
            liveYear: 2026,
            snapshotYears: [2024],
            years: [
                {
                    year: 2026,
                    isCurrent: true,
                    hasSnapshot: false,
                    hasTransactions: false,
                },
                {
                    year: 2024,
                    isCurrent: false,
                    hasSnapshot: true,
                    hasTransactions: false,
                },
            ],
        });
        const user = userEvent.setup();
        render(<TaxYearSwitcher />);
        await user.click(
            screen.getByRole("button", { name: /switch tax year/i }),
        );
        await screen.findAllByRole("menuitem");
        expect(
            screen.queryByText(/create profile for 2024/i),
        ).not.toBeInTheDocument();
    });

    it("hides the create-snapshot footer when viewing the live year", async () => {
        setup({
            viewedYear: 2026,
            liveYear: 2026,
            snapshotYears: [],
            years: [
                {
                    year: 2026,
                    isCurrent: true,
                    hasSnapshot: false,
                    hasTransactions: false,
                },
            ],
        });
        const user = userEvent.setup();
        render(<TaxYearSwitcher />);
        await user.click(
            screen.getByRole("button", { name: /switch tax year/i }),
        );
        await screen.findAllByRole("menuitem");
        expect(
            screen.queryByText(/create profile for/i),
        ).not.toBeInTheDocument();
    });
});
