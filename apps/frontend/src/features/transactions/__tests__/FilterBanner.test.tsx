// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { FilterBanner } from "../components/FilterBanner";

vi.mock("../components/TransactionsExportButtons", () => ({
    TransactionsExportButtons: () => null,
}));
vi.mock("@/stores/hydration/AppSettingsHydration", async (original) => ({
    ...(await original<
        typeof import("@/stores/hydration/AppSettingsHydration")
    >()),
    useAppSettings: () => ({
        appSettings: {
            defaultCurrency: "EUR",
            numberFormat: "eu",
            dateFormat: "DD/MM/YYYY",
        },
    }),
}));

describe("FilterBanner", () => {
    it("summarizes every scope when a label accompanies combined filters", async () => {
        renderWithApp(
            <FilterBanner
                recipientIdFilter={7}
                accountIdFilter={3}
                categoryIdsFilter={[4, 5]}
                filterLabel="Main account"
                onClear={vi.fn()}
            />,
        );
        const banner = await screen.findByText(/Filtered by /i);
        expect(banner).toHaveTextContent("Main account");
        expect(banner).toHaveTextContent("Recipient #7");
        expect(banner).toHaveTextContent("Account #3");
        expect(banner).toHaveTextContent("Categories (2)");
    });
    it("uses a supplied label once for a single scope", async () => {
        renderWithApp(
            <FilterBanner
                accountIdFilter={3}
                filterLabel="Main account"
                onClear={vi.fn()}
            />,
        );
        const banner = await screen.findByText(/Filtered by /i);
        expect(banner).toHaveTextContent("Main account");
        expect(banner).not.toHaveTextContent("Account #3");
    });
    it("describes category filters and formats signed bounds locally", async () => {
        renderWithApp(
            <FilterBanner
                categoryIdsFilter={[4, 5]}
                amountMinFilter={1234.56}
                amountMaxFilter={1234.56}
                amountSignedFilter
                onClear={vi.fn()}
            />,
        );
        const banner = await screen.findByText(/Filtered by /i);
        expect(banner).toHaveTextContent("Categories (2)");
        expect(banner).toHaveTextContent("+1.234,56 EUR");
    });
});
