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
        tc: (key: string, count: number) => `${key}:${count}`,
    }),
}));

describe("HistoricalFxFallbackWarning", () => {
    it("renders affected currencies when recipient totals used a fallback", () => {
        render(
            <HistoricalFxFallbackWarning
                conversion={{
                    usedHistoricalFallback: true,
                    affectedCurrencies: ["GBP", "USD"],
                    unconvertedCount: 0,
                    unconvertedCurrencies: [],
                }}
            />,
        );

        expect(screen.getByRole("status")).toHaveTextContent(
            "Historical rates unavailable: GBP, USD",
        );
    });

    it("stays hidden when every historical rate resolved", () => {
        const { container } = render(
            <HistoricalFxFallbackWarning
                conversion={{
                    usedHistoricalFallback: false,
                    affectedCurrencies: [],
                    unconvertedCount: 0,
                    unconvertedCurrencies: [],
                }}
            />,
        );

        expect(container).toBeEmptyDOMElement();
    });

    it("says how many transactions were left out for want of any rate", () => {
        render(
            <HistoricalFxFallbackWarning
                conversion={{
                    usedHistoricalFallback: false,
                    affectedCurrencies: [],
                    unconvertedCount: 3,
                    unconvertedCurrencies: ["XYZ"],
                }}
            />,
        );

        expect(
            screen.getByText("common.fxUnavailableTransactions:3"),
        ).toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
});
