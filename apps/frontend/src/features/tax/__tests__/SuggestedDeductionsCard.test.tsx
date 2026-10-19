// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SuggestedDeductionsCard from "../SuggestedDeductionsCard";

vi.mock("@/stores/hydration/LanguageHydration", () => ({
    LanguageProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    useLanguage: () => ({
        t: (key: string, vars?: Record<string, string | number>) => {
            const translations: Record<string, string> = {
                "tax.suggestions.title":
                    "Possible deductions / credits you may qualify for",
                "tax.suggestions.item.childcare": "Childcare",
                "tax.suggestions.childcare.suggest":
                    "Example with {days} days",
                "tax.suggestions.none": "No suggestions",
            };
            let text = translations[key] ?? key;
            for (const [name, value] of Object.entries(vars ?? {}))
                text = text.replaceAll(`{${name}}`, String(value));
            return text;
        },
        language: "en",
        setLanguage: () => {},
    }),
}));

vi.mock("@/hooks/useCurrencyFormatter", () => ({
    useCurrencyFormatter: () => (value: number) => `EUR ${value}`,
}));

vi.mock("../TaxProfileDialog", () => ({
    TaxProfileDialog: ({ trigger }: { trigger: React.ReactNode }) => (
        <>{trigger}</>
    ),
}));

describe("SuggestedDeductionsCard", () => {
    it("renders the server suggestions with translated text and estimates", () => {
        render(
            <SuggestedDeductionsCard
                suggestions={[
                    {
                        id: "childcare.suggest",
                        titleKey: "tax.suggestions.item.childcare",
                        descriptionKey: "tax.suggestions.childcare.suggest",
                        descriptionParams: { days: 120 },
                        estimate: 540,
                    },
                ]}
            />,
        );
        expect(screen.getByText(/Possible deductions/i)).toBeInTheDocument();
        expect(screen.getByText("Childcare")).toBeInTheDocument();
        expect(screen.getByText("Example with 120 days")).toBeInTheDocument();
        expect(screen.getByText("EUR 540")).toBeInTheDocument();
    });

    it("shows the no-suggestions state for an empty list", () => {
        render(<SuggestedDeductionsCard suggestions={[]} />);
        expect(screen.getByText("No suggestions")).toBeInTheDocument();
    });
});
