// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HistoricalFxFallbackWarning } from "@/features/statistics/HistoricalFxFallbackWarning";

vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({
        t: (key: string, vars?: Record<string, string>) =>
            key === "common.unknown"
                ? "Unknown"
                : `Historical rates unavailable: ${vars?.currencies}`,
    }),
}));

describe("HistoricalFxFallbackWarning", () => {
    it("renders affected currencies when recipient totals used a fallback", () => {
        render(
            <HistoricalFxFallbackWarning
                conversion={{
                    usedHistoricalFallback: true,
                    affectedCurrencies: ["GBP", "USD"],
                }}
            />,
        );

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Historical rates unavailable: GBP, USD",
        );
    });

    it("stays hidden when every historical rate resolved", () => {
        const { container } = render(
            <HistoricalFxFallbackWarning
                conversion={{
                    usedHistoricalFallback: false,
                    affectedCurrencies: [],
                }}
            />,
        );

        expect(container).toBeEmptyDOMElement();
    });
});
