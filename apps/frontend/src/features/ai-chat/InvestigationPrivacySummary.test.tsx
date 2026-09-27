// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { InvestigationPrivacySummary } from "./InvestigationPrivacySummary";

describe("InvestigationPrivacySummary", () => {
    it("separates local model privacy from external research access", async () => {
        renderWithApp(
            <InvestigationPrivacySummary
                route="local"
                disclosureMode="cloud-plan-public"
                researchMode="public-web"
                depth="quick"
            />,
        );
        expect(
            await screen.findByText("Your local model"),
        ).toBeVisible();
        expect(
            screen.getByText(/Sends your separate search query/),
        ).toBeVisible();
        expect(
            screen.getByText(
                "The investigation and its evidence stay saved on your device.",
            ),
        ).toBeVisible();
        const details = screen
            .getByText("Privacy details for these settings")
            .closest("details");
        expect(details).not.toHaveAttribute("open");
        expect(
            screen.queryByText(/OpenAI public planning —/),
        ).not.toBeInTheDocument();
    });

    it("updates the explanation and privacy detail when cloud mode changes", async () => {
        const { rerender } = renderWithApp(
            <InvestigationPrivacySummary
                route="openai-api"
                disclosureMode="cloud-plan-public"
                researchMode="local-only"
                depth="quick"
            />,
        );
        expect(
            await screen.findByText("Cloud plans · local answers"),
        ).toBeVisible();
        rerender(
            <InvestigationPrivacySummary
                route="openai-api"
                disclosureMode="cloud-synthesis-selected"
                researchMode="local-only"
                depth="detailed"
            />,
        );
        expect(
            await screen.findByText("OpenAI writes the answer"),
        ).toBeVisible();
        expect(
            screen.getByText(/Evidence may contain private data/),
        ).toBeVisible();
        expect(screen.getByText(/Provider retention may differ/)).toBeVisible();
        expect(screen.getByText("Selected evidence only")).toBeVisible();
        expect(screen.queryByText(/Uses Vision and your documents/)).not.toBeInTheDocument();
        expect(
            screen.queryByText("Cloud plans · local answers"),
        ).not.toBeInTheDocument();
        expect(
            screen.getByText(/OpenAI selected-evidence synthesis —/),
        ).toBeInTheDocument();
    });
});
