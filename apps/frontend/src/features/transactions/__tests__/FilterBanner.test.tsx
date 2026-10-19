// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { FilterBanner } from "../components/FilterBanner";
import { asAccountId, asCategoryId, asRecipientId } from "@vision/types/brands";

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
                recipientIdFilter={asRecipientId(7)}
                accountIdFilter={asAccountId(3)}
                categoryIdsFilter={[asCategoryId(4), asCategoryId(5)]}
                filterLabel="Main account"
                onClear={vi.fn()}
            />,
        );
        const banner = await screen.findByText(/Filtered by /i);
        expect(banner).toHaveTextContent("Main account");
        await screen.findByText(/Test Recipient/);
        expect(banner).toHaveTextContent("Test Recipient");
        expect(banner).toHaveTextContent("Account 3");
        expect(banner).toHaveTextContent("Categories (2)");
    });
    it("uses a supplied label once for a single scope", async () => {
        renderWithApp(
            <FilterBanner
                accountIdFilter={asAccountId(3)}
                filterLabel="Main account"
                onClear={vi.fn()}
            />,
        );
        const banner = await screen.findByText(/Filtered by /i);
        expect(banner).toHaveTextContent("Main account");
        expect(banner).not.toHaveTextContent("Account 3");
    });
    it("describes category filters and formats signed bounds locally", async () => {
        renderWithApp(
            <FilterBanner
                categoryIdsFilter={[asCategoryId(4), asCategoryId(5)]}
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
