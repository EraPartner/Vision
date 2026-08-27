// @vitest-environment jsdom

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PriceFreshnessCaption } from "@/features/portfolio/PriceFreshnessCaption";
import { renderWithApp } from "@/test/renderWithApp";

vi.mock("@/contexts/LanguageContext", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@/contexts/LanguageContext")>();
    const { default: en } = await import("@/locales/en");
    return {
        ...actual,
        useLanguage: () => ({
            language: "en",
            t: (key: string, vars?: Record<string, string | number>) => {
                let text = en[key] ?? key;
                for (const [name, value] of Object.entries(vars ?? {})) {
                    text = text.replaceAll(`{${name}}`, String(value));
                }
                return text;
            },
        }),
    };
});

vi.mock("@/contexts/AppSettingsContext", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@/contexts/AppSettingsContext")>();
    return {
        ...actual,
        useAppSettings: () => ({
            appSettings: {
                dateFormat: "DD/MM/YYYY",
                numberFormat: "eu",
            },
        }),
    };
});

describe("PriceFreshnessCaption", () => {
    it("shows the oldest live quote even when it is only five minutes old", () => {
        renderWithApp(
            <PriceFreshnessCaption
                investments={[
                    {
                        price_provider: "yahoo",
                        price_updated_at: "2026-06-22T11:55:00.000Z",
                    },
                    {
                        price_provider: "manual",
                        price_updated_at: null,
                    },
                ]}
            />,
        );

        expect(screen.getByText(/Prices as of/)).toHaveTextContent(
            "22/06/2026",
        );
    });

    it("shows a truthful missing state for an un-timestamped live holding", () => {
        renderWithApp(
            <PriceFreshnessCaption
                investments={[
                    { price_provider: "yahoo", price_updated_at: null },
                ]}
            />,
        );
        expect(screen.getByText("Live prices not fetched")).toBeInTheDocument();
    });

    it("uses investment provenance copy for Net Worth", () => {
        renderWithApp(
            <PriceFreshnessCaption
                scope="investment"
                investments={[
                    {
                        price_provider: "binance",
                        price_updated_at: "2026-06-22T11:55:00.000Z",
                    },
                ]}
            />,
        );
        expect(screen.getByText(/Investment prices as of/)).toBeInTheDocument();
    });

    it("formats the date and time from the same local instant across UTC midnight", () => {
        const timestamp = "2026-06-22T23:55:00.000Z";
        const localDate = new Date(timestamp);
        const expectedDate = [
            String(localDate.getDate()).padStart(2, "0"),
            String(localDate.getMonth() + 1).padStart(2, "0"),
            localDate.getFullYear(),
        ].join("/");

        renderWithApp(
            <PriceFreshnessCaption
                investments={[
                    { price_provider: "yahoo", price_updated_at: timestamp },
                ]}
            />,
        );

        expect(screen.getByText(/Prices as of/)).toHaveTextContent(
            expectedDate,
        );
    });

    it("renders nothing for manual-only holdings", () => {
        const { container } = renderWithApp(
            <PriceFreshnessCaption
                investments={[
                    { price_provider: "manual", price_updated_at: null },
                    { price_updated_at: null },
                ]}
            />,
        );
        expect(container).toBeEmptyDOMElement();
    });
});
