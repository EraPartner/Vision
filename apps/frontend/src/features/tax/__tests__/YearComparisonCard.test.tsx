// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({
        t: (key: string, vars?: Record<string, string | number>) => {
            const dict: Record<string, string> = {
                "tax.comparison.description":
                    "Compare the viewed year against another year on file.",
                "tax.comparison.header.delta": "Delta",
                "tax.comparison.header.metric": "Metric",
                "tax.comparison.row.effectiveRate": "Effective tax rate",
                "tax.comparison.row.grossIncome": "Gross income",
                "tax.comparison.row.netTakeHome": "Net take-home",
                "tax.comparison.row.totalPIT": "Total PIT",
                "tax.comparison.selectYear": "Compare with year",
                "tax.comparison.title": "{year} vs another year",
                "tax.comparison.versus": "vs",
            };
            let value = dict[key] ?? key;
            for (const [name, replacement] of Object.entries(vars ?? {})) {
                value = value.replaceAll(`{${name}}`, String(replacement));
            }
            return value;
        },
    }),
}));

vi.mock("@/contexts/BelgianTaxProfileContext", () => ({
    useBelgianTaxProfile: vi.fn(),
}));

vi.mock("@/hooks/useAvailableTaxYears", () => ({
    useAvailableTaxYears: vi.fn(),
}));

vi.mock("@/hooks/useCurrencyFormatter", () => ({
    useCurrencyFormatter:
        () => (value: number, options?: string | { signed?: boolean }) => {
            const signed = typeof options === "object" && options.signed;
            const sign = signed ? (value > 0 ? "+" : value < 0 ? "-" : "") : "";
            return `${sign}€${signed ? Math.abs(value) : value}`;
        },
    usePercentFormatter:
        () =>
        (value: number, options?: { digits?: number; signed?: boolean }) => {
            const digits = options?.digits ?? 1;
            const sign = options?.signed && value > 0 ? "+" : "";
            return `${sign}${value.toFixed(digits)}%`;
        },
}));

import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { useAvailableTaxYears } from "@/hooks/useAvailableTaxYears";
import { YearComparisonCard } from "../YearComparisonCard";

const mockedProfile = vi.mocked(useBelgianTaxProfile);
const mockedYears = vi.mocked(useAvailableTaxYears);

describe("YearComparisonCard", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const calculationForYear = (year: number) => ({
            grossIncome: year === 2026 ? 60_000 : 55_000,
            totalPIT: year === 2026 ? 15_000 : 13_000,
            effectiveRate: year === 2026 ? 25 : 23.6,
            netTakeHome: year === 2026 ? 40_000 : 38_000,
        });
        mockedProfile.mockImplementation((selector) =>
            selector({
                viewedYear: 2026,
                profile: { taxYear: 2026 },
                snapshots: { 2025: { taxYear: 2025 } },
                snapshotMetas: {
                    2025: { frozenCalculation: calculationForYear(2025) },
                    2026: { frozenCalculation: calculationForYear(2026) },
                },
            } as never),
        );
        mockedYears.mockReturnValue([
            {
                year: 2026,
                isCurrent: true,
                hasSnapshot: false,
                hasTransactions: true,
                isFiled: false,
                hasFrozenCalculation: false,
            },
            {
                year: 2025,
                isCurrent: false,
                hasSnapshot: true,
                hasTransactions: true,
                isFiled: false,
                hasFrozenCalculation: true,
            },
        ]);
    });

    it("gives the comparison-year selector a localized accessible name", () => {
        render(<YearComparisonCard />);

        expect(
            screen.getByRole("combobox", { name: "Compare with year" }),
        ).toBeInTheDocument();
    });

    it("uses gain/loss DeltaPill tones with inverted tax semantics", () => {
        render(<YearComparisonCard />);

        const grossRow = screen.getByText("Gross income").closest("tr");
        const taxRow = screen.getByText("Total PIT").closest("tr");
        expect(grossRow).not.toBeNull();
        expect(taxRow).not.toBeNull();

        const grossPill = within(grossRow!).getAllByRole("cell")[3]
            .firstElementChild;
        const taxPill = within(taxRow!).getAllByRole("cell")[3]
            .firstElementChild;
        expect(grossPill).toHaveClass("text-gain", "bg-gain/12");
        expect(taxPill).toHaveClass("text-loss", "bg-loss/12");
        expect(grossPill).toHaveTextContent("+€5000 (+9.1%)");
        expect(taxPill).toHaveTextContent("+€2000 (+15.4%)");
    });

    it("keeps a negative sign on money deltas", () => {
        const calculationForYear = (year: number) => ({
            grossIncome: year === 2026 ? 50_000 : 55_000,
            totalPIT: 13_000,
            effectiveRate: 23.6,
            netTakeHome: 38_000,
        });
        mockedProfile.mockImplementation((selector) =>
            selector({
                viewedYear: 2026,
                profile: { taxYear: 2026 },
                snapshots: { 2025: { taxYear: 2025 } },
                snapshotMetas: {
                    2025: { frozenCalculation: calculationForYear(2025) },
                    2026: { frozenCalculation: calculationForYear(2026) },
                },
            } as never),
        );

        render(<YearComparisonCard />);
        const grossRow = screen.getByText("Gross income").closest("tr");
        expect(within(grossRow!).getAllByRole("cell")[3]).toHaveTextContent(
            "-€5000",
        );
    });
});
