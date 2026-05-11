// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { TaxProfileDialog } from "@/components/tax/TaxProfileDialog";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Open the sheet by clicking the default trigger. */
async function openSheet(user: ReturnType<typeof userEvent.setup>) {
    const trigger = await screen.findByRole("button", { name: /tax profile/i });
    await user.click(trigger);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TaxProfileDialog", () => {
    it("renders default trigger button with settings icon", async () => {
        // Arrange
        renderWithApp(<TaxProfileDialog />);

        // Assert — default trigger contains translated label
        expect(await screen.findByRole("button", { name: /tax profile/i })).toBeInTheDocument();
    });

    it("opens sheet on trigger click", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        // Act
        await openSheet(user);

        // Assert — sheet header title is visible
        expect(await screen.findByText("Belgian Tax Profile")).toBeInTheDocument();
    });

    it("shows employment step by default (radio options visible)", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        // Act
        await openSheet(user);

        // Assert — employment type section heading and at least one radio option
        // Note: accessible name includes the full label (name + description text concatenated)
        expect(await screen.findByText("Employment type")).toBeInTheDocument();
        expect(await screen.findByRole("radio", { name: /^Employee/ })).toBeInTheDocument();
    });

    it("'Back' button is disabled on the first step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        // Act
        await openSheet(user);
        await screen.findByText("Employment type");

        // Assert
        const backBtn = screen.getByRole("button", { name: /back/i });
        expect(backBtn).toBeDisabled();
    });

    it("'Next' button advances to income step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        // Act
        await openSheet(user);
        await screen.findByText("Employment type");
        await user.click(screen.getByRole("button", { name: /next/i }));

        // Assert — income step heading visible
        expect(await screen.findByText("Income details")).toBeInTheDocument();
    });

    it("can navigate through all 4 steps using Next", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        // Act
        await openSheet(user);
        await screen.findByText("Employment type");

        // Step 1 → 2
        await user.click(screen.getByRole("button", { name: /next/i }));
        expect(await screen.findByText("Income details")).toBeInTheDocument();

        // Step 2 → 3 (income sources)
        await user.click(screen.getByRole("button", { name: /next/i }));
        expect(await screen.findByText("Taxable income sources")).toBeInTheDocument();

        // Step 3 → 4
        await user.click(screen.getByRole("button", { name: /next/i }));
        expect(await screen.findByText("Exemptions & dependents")).toBeInTheDocument();

        // Step 4 → 5
        await user.click(screen.getByRole("button", { name: /next/i }));
        expect(await screen.findByText("Region & communal surcharge")).toBeInTheDocument();
    });

    it("on last step (region), shows 'Save' button instead of 'Next'", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        // Act — advance to last step
        await openSheet(user);
        await screen.findByText("Employment type");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText("Income details");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText("Taxable income sources");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText("Exemptions & dependents");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText("Region & communal surcharge");

        // Assert — Save button present, Next gone
        expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^next$/i })).not.toBeInTheDocument();
    });

    it("clicking 'Save' on last step closes the sheet", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        // Act — navigate to last step
        await openSheet(user);
        await screen.findByText("Employment type");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText("Income details");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText("Taxable income sources");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText("Exemptions & dependents");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText("Region & communal surcharge");

        // Act — click Save
        await user.click(screen.getByRole("button", { name: /save/i }));

        // Assert — sheet content disappears
        await waitFor(() =>
            expect(screen.queryByText("Belgian Tax Profile")).not.toBeInTheDocument(),
        );
    });

    it("step indicator buttons allow jumping to a different step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        // Act — open sheet, then click the Region step indicator
        await openSheet(user);
        await screen.findByText("Employment type");

        // Step indicator buttons render the translated step label on sm+ screens;
        // use the visible text "Region" in the indicator nav area
        const stepButtons = await screen.findAllByRole("button", { name: /region/i });
        // The first match is the step indicator (the trigger is "Tax Profile", not "Region")
        await user.click(stepButtons[0]);

        // Assert — jumps directly to region step
        expect(await screen.findByText("Region & communal surcharge")).toBeInTheDocument();
    });

    it("initialStep prop opens directly to the specified step", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog initialStep="income" />);

        // Act
        await openSheet(user);

        // Assert — income step shown without navigating through employment
        expect(await screen.findByText("Income details")).toBeInTheDocument();
        expect(screen.queryByText("Employment type")).not.toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key closes the sheet", async () => {
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);
        await openSheet(user);
        await screen.findByText("Belgian Tax Profile");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByText("Belgian Tax Profile")).not.toBeInTheDocument());
    });

    it("sheet renders in open state (a11y / backdrop guard)", async () => {
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);
        await openSheet(user);
        const sheet = await screen.findByRole("dialog");
        expect(sheet).toHaveAttribute("data-state", "open");
    });

    it("first interactive element is reachable inside the sheet (keyboard nav)", async () => {
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);
        await openSheet(user);
        await screen.findByText("Employment type");
        const radios = screen.getAllByRole("radio");
        expect(radios.length).toBeGreaterThan(0);
    });
});
