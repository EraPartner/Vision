// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { AIInvestigationPanel } from "./AIInvestigationPanel";

vi.mock("@/hooks/useAiResearchStatus", () => ({
    useAiResearchStatus: () => ({
        data: { openai: { enabled: true, models: [], model: "" } },
    }),
}));
vi.mock("@/lib/api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/api")>();
    return {
        ...actual,
        apiClient: {
            ...actual.apiClient,
            listResearchDocuments: vi.fn().mockResolvedValue([]),
        },
    };
});

describe("AIInvestigationPanel progressive controls", () => {
    it("keeps the question, action and privacy visible while preserving optional controls", async () => {
        const user = userEvent.setup();
        renderWithApp(<AIInvestigationPanel />);
        const question = await screen.findByRole("textbox", {
            name: /financial or research question/i,
        });
        expect(question).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Start investigation" }),
        ).toBeDisabled();
        expect(screen.getByText("Your local model")).toBeVisible();
        const settings = screen
            .getByText("Research settings")
            .closest("details")!;
        expect(settings).not.toHaveAttribute("open");
        expect(
            within(settings).getByRole("radio", { name: "Local model" }),
        ).not.toBeVisible();
        await user.click(within(settings).getByText("Research settings"));
        await user.click(
            within(settings).getByRole("radio", { name: "Detailed" }),
        );
        await user.click(within(settings).getByText("Research settings"));
        expect(settings.querySelector("summary")).toHaveTextContent("Detailed");
        await user.type(question, "Explain my portfolio");
        expect(
            screen.getByRole("button", { name: "Start investigation" }),
        ).toBeEnabled();
        await user.click(screen.getByText("Documents and date range"));
        expect(screen.getByLabelText("From")).toBeVisible();
    });
    it("keeps cloud disclosure inputs visible after closing settings", async () => {
        const user = userEvent.setup();
        renderWithApp(<AIInvestigationPanel />);
        await user.click(await screen.findByText("Research settings"));
        await user.click(screen.getByRole("radio", { name: /OpenAI API/ }));
        await user.click(screen.getByText("Research settings"));
        expect(
            screen.getByText("Research settings").closest("summary"),
        ).toHaveTextContent("OpenAI API");
        expect(
            screen.getByPlaceholderText(
                /Write a separate public-only planning question/,
            ),
        ).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Preview cloud payload" }),
        ).toBeDisabled();
        await user.click(screen.getByText("Research settings"));
        expect(screen.getByRole("radio", { name: /OpenAI API/ })).toBeChecked();
    });
});
