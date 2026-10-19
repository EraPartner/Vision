// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BelgianTaxDashboardYear } from "@/lib/api/belgianTax";

const setViewedYear = vi.hoisted(() => vi.fn());

vi.mock("@/contexts/BelgianTaxProfileContext", () => ({
    useBelgianTaxProfile: (selector: (state: object) => unknown) =>
        selector({ viewedYear: 2026, setViewedYear }),
}));
vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
    useCurrencyFormatter: () => (value: number) => `EUR ${value}`,
    usePercentFormatter: () => (value: number) => `${value}%`,
}));

import { MultiYearTrendStrip } from "@/features/tax/MultiYearTrendStrip";

function year(
    value: number,
    totalPIT: number,
    effectiveRate: number,
): BelgianTaxDashboardYear {
    return {
        year: value,
        calculation: { totalPIT, effectiveRate },
        isCurrent: value === 2026,
        hasSnapshot: false,
        hasTransactions: true,
        isFiled: false,
        hasFrozenCalculation: false,
    };
}

describe("MultiYearTrendStrip", () => {
    it("renders one tile per dashboard year with its server calculation", () => {
        render(
            <MultiYearTrendStrip
                years={[year(2026, 15_000, 25), year(2025, 13_000, 23.6)]}
            />,
        );
        expect(screen.getByText("EUR 15000")).toBeInTheDocument();
        expect(screen.getByText("EUR 13000")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /2026/, pressed: true }),
        ).toBeInTheDocument();
    });

    it("switches the viewed year when a tile is clicked", async () => {
        const user = userEvent.setup();
        render(
            <MultiYearTrendStrip
                years={[year(2026, 15_000, 25), year(2025, 13_000, 23.6)]}
            />,
        );
        await user.click(screen.getByRole("button", { name: /2025/ }));
        expect(setViewedYear).toHaveBeenCalledWith(2025);
    });

    it("renders nothing for a single year", () => {
        const { container } = render(
            <MultiYearTrendStrip years={[year(2026, 15_000, 25)]} />,
        );
        expect(container).toBeEmptyDOMElement();
    });
});
