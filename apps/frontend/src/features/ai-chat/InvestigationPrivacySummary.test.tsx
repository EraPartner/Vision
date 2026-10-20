// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { InvestigationPrivacySummary } from "./InvestigationPrivacySummary";

describe("InvestigationPrivacySummary", () => {
    it("separates local model privacy from external research access", async () => {
        renderWithApp(
            <InvestigationPrivacySummary
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
    });
});
