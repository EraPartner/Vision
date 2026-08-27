// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { TaxProfileDialog } from "@/features/tax/TaxProfileDialog";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Open the sheet by clicking the default trigger. */
async function openSheet(user: ReturnType<typeof userEvent.setup>) {
    const trigger = await screen.findByRole("button", { name: /tax profile/i });
    await user.click(trigger);
}

/**
 * Fill the income step's required gross-annual-income field. The dialog now gates
 * forward navigation on this being > 0, so any test that walks past the income
 * step must provide it first.
 */
async function fillGrossIncome(user: ReturnType<typeof userEvent.setup>) {
    const input = await screen.findByLabelText(/gross annual income/i);
    await user.clear(input);
    await user.type(input, "50000");
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

    it("renders zero-valued profile fields as 0 instead of an empty input", async () => {
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        await openSheet(user);
        await user.click(screen.getByRole("button", { name: /next/i }));

        expect(await screen.findByLabelText(/gross annual income/i)).toHaveValue("0");
        expect(screen.getByLabelText(/other taxable income/i)).toHaveValue("0");
    });

    it("keeps a trailing decimal separator visible while editing and normalizes it on blur", async () => {
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        await openSheet(user);
        await user.click(screen.getByRole("button", { name: /next/i }));
        const income = await screen.findByLabelText(/gross annual income/i);
        await user.clear(income);
        await user.type(income, "12.");

        expect(income).toHaveValue("12.");
        await user.tab();
        expect(income).toHaveValue("12");
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

        // Income step now requires a gross annual income before advancing.
        await fillGrossIncome(user);

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
        await fillGrossIncome(user);
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
        await fillGrossIncome(user);
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

        // Act — open sheet, advance to income and satisfy its required field so a
        // forward jump is permitted (jumping past an incomplete step is blocked).
        await openSheet(user);
        await screen.findByText("Employment type");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText("Income details");
        await fillGrossIncome(user);

        // Step indicator buttons render the translated step label on sm+ screens;
        // use the visible text "Region" in the indicator nav area
        const stepButtons = await screen.findAllByRole("button", { name: /region/i });
        // The first match is the step indicator (the trigger is "Tax Profile", not "Region")
        await user.click(stepButtons[0]);

        // Assert — jumps directly to region step
        expect(await screen.findByText("Region & communal surcharge")).toBeInTheDocument();
    });

    it("blocks jumping forward past an incomplete step, redirecting to it", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        // Act — from the (valid) employment step, try to jump straight to Region.
        // Income has no gross-income yet, so the forward jump is refused and the
        // dialog lands the user on the incomplete income step instead.
        await openSheet(user);
        await screen.findByText("Employment type");
        const stepButtons = await screen.findAllByRole("button", { name: /region/i });
        await user.click(stepButtons[0]);

        // Assert — redirected to income, not region
        expect(await screen.findByText("Income details")).toBeInTheDocument();
        expect(screen.queryByText("Region & communal surcharge")).not.toBeInTheDocument();
    });

    it("blocks advancing past the income step until gross income is provided", async () => {
        // Arrange
        const user = userEvent.setup();
        renderWithApp(<TaxProfileDialog />);

        // Act — reach the income step and try to advance with no income
        await openSheet(user);
        await screen.findByText("Employment type");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText("Income details");
        await user.click(screen.getByRole("button", { name: /next/i }));

        // Assert — still on income (advancement blocked)
        expect(screen.getByText("Income details")).toBeInTheDocument();
        expect(screen.queryByText("Taxable income sources")).not.toBeInTheDocument();

        // Act — provide income, then advancing works
        await fillGrossIncome(user);
        await user.click(screen.getByRole("button", { name: /next/i }));

        // Assert
        expect(await screen.findByText("Taxable income sources")).toBeInTheDocument();
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
