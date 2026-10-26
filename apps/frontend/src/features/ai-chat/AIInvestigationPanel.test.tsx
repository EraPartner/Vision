// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithApp } from "@/test/renderWithApp";
import { AIInvestigationPanel } from "./AIInvestigationPanel";
import { must } from "@/test/must";

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
        const settings = must(
            screen.getByText("Research settings").closest("details"),
            "research settings details",
        );
        expect(settings).not.toHaveAttribute("open");
        expect(
            within(settings).getByRole("radio", { name: "Quick" }),
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
    it("offers no cloud route", async () => {
        const user = userEvent.setup();
        renderWithApp(<AIInvestigationPanel />);
        await user.click(await screen.findByText("Research settings"));
        expect(
            screen.queryByRole("radio", { name: /OpenAI/ }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/OpenAI/)).not.toBeInTheDocument();
    });
});
