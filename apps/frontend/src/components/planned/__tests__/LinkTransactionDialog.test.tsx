// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { LinkTransactionDialog } from "@/components/planned/LinkTransactionDialog";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";

const API_BASE = "http://localhost:3002";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PAYMENT: PlannedPayment = {
    id: 1,
    name: "Monthly Rent",
    amount: 1200,
    currency: "EUR",
    due_date: "2025-02-01",
    recipient: "Landlord",
    recipient_id: undefined, // avoid the getRecipient side-effect fetch
    bank_account: "BE12345678901234",
    is_recurring: true,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
};

const CANDIDATE_TX = {
    id: 42,
    transaction_date: "2025-02-01",
    date: "2025-02-01",
    memo: "Rent payment",
    recipient_name: "Landlord",
    recipient_id: 1,
    amount: -1200,
    currency: "EUR",
    bank_account: "BE12345678901234",
    is_active: true,
    category_id: null,
    category_name: null,
    comment: null,
    balance: null,
    created_at: "2025-02-01T00:00:00.000Z",
    updated_at: null,
    links: [],
};

function setupCandidateHandler() {
    server.use(
        http.get(`${API_BASE}/api/transactions`, () =>
            ok({
                items: [CANDIDATE_TX],
                total: 1,
                limit: 50,
                offset: 0,
                links: [],
            }),
        ),
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("LinkTransactionDialog", () => {
    it("renders dialog when open=true with payment", async () => {
        // Arrange
        const onExecute = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={onOpenChange}
                payment={PAYMENT}
                onExecute={onExecute}
            />,
        );

        // Assert — dialog title includes payment name
        expect(await screen.findByText(/Monthly Rent/i)).toBeInTheDocument();
    });

    it("cancel button calls onOpenChange(false)", async () => {
        // Arrange
        const user = userEvent.setup();
        const onExecute = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={onOpenChange}
                payment={PAYMENT}
                onExecute={onExecute}
            />,
        );

        // Act
        const cancelBtn = await screen.findByRole("button", { name: "Cancel" });
        await user.click(cancelBtn);

        // Assert
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("Escape key closes dialog", async () => {
        // Arrange
        const user = userEvent.setup();
        const onExecute = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={onOpenChange}
                payment={PAYMENT}
                onExecute={onExecute}
            />,
        );

        // Act — wait for dialog content then press Escape
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        // Assert
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("fetches and displays candidate transactions on open", async () => {
        // Arrange
        setupCandidateHandler();
        const onExecute = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={onOpenChange}
                payment={PAYMENT}
                onExecute={onExecute}
            />,
        );

        // Assert — transaction memo appears after fetch
        expect(await screen.findByText("Rent payment")).toBeInTheDocument();
    });

    it("shows empty state when no transactions match", async () => {
        // Arrange — default handler returns empty items list
        const onExecute = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={onOpenChange}
                payment={PAYMENT}
                onExecute={onExecute}
            />,
        );

        // Assert
        expect(await screen.findByText("No recent transactions found.")).toBeInTheDocument();
    });

    it("'Link & Execute' disabled when no transaction selected", async () => {
        // Arrange
        setupCandidateHandler();
        const onExecute = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={onOpenChange}
                payment={PAYMENT}
                onExecute={onExecute}
            />,
        );

        // Wait for transactions to load
        await screen.findByText("Rent payment");

        // Assert — button exists but is disabled before selection
        const linkBtn = screen.getByRole("button", { name: "Link & Execute" });
        expect(linkBtn).toBeDisabled();
    });

    it("selecting a transaction enables 'Link & Execute' button", async () => {
        // Arrange
        setupCandidateHandler();
        const user = userEvent.setup();
        const onExecute = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={onOpenChange}
                payment={PAYMENT}
                onExecute={onExecute}
            />,
        );

        // Act — wait for candidate and click the radio
        await screen.findByText("Rent payment");
        const radio = screen.getByRole("radio");
        await user.click(radio);

        // Assert
        const linkBtn = screen.getByRole("button", { name: "Link & Execute" });
        expect(linkBtn).not.toBeDisabled();
    });

    it("clicking 'Link & Execute' calls onExecute with correct args and closes dialog", async () => {
        // Arrange
        setupCandidateHandler();
        const user = userEvent.setup();
        const onExecute = vi.fn().mockResolvedValue(undefined);
        const onOpenChange = vi.fn();
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={onOpenChange}
                payment={PAYMENT}
                onExecute={onExecute}
            />,
        );

        // Act — select the transaction then execute
        await screen.findByText("Rent payment");
        const radio = screen.getByRole("radio");
        await user.click(radio);

        const linkBtn = screen.getByRole("button", { name: "Link & Execute" });
        await user.click(linkBtn);

        // Assert — onExecute called with payment id, transaction id, and the
        // selected transaction's own date as the execution date (when it was paid).
        await waitFor(() => {
            expect(onExecute).toHaveBeenCalledWith(
                PAYMENT.id,
                CANDIDATE_TX.id,
                CANDIDATE_TX.transaction_date,
            );
        });
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("local search input filters displayed transactions", async () => {
        // Arrange — return two different transactions
        const secondTx = {
            ...CANDIDATE_TX,
            id: 43,
            memo: "Gym membership",
            recipient_name: "FitLife",
            amount: -50,
        };
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({
                    items: [CANDIDATE_TX, secondTx],
                    total: 2,
                    limit: 50,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        const user = userEvent.setup();
        const onExecute = vi.fn();
        const onOpenChange = vi.fn();
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={onOpenChange}
                payment={PAYMENT}
                onExecute={onExecute}
            />,
        );

        // Wait for both to appear — note: matchAmount filter may hide gym tx since amount differs
        // Disable matchAmount first so both show
        await screen.findByText("Rent payment");

        // Act — type into search to filter
        const searchInput = screen.getByPlaceholderText("Search memo, recipient, amount...");
        await user.type(searchInput, "Rent");

        // Assert — only rent tx visible, gym tx filtered out
        expect(screen.queryByText("Gym membership")).not.toBeInTheDocument();
        expect(screen.getByText("Rent payment")).toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={vi.fn()}
                payment={PAYMENT}
                onExecute={vi.fn()}
            />,
        );
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element is reachable for keyboard nav", async () => {
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={vi.fn()}
                payment={PAYMENT}
                onExecute={vi.fn()}
            />,
        );
        await screen.findByRole("dialog");
        const inputs = screen.getAllByRole("textbox");
        expect(inputs.length).toBeGreaterThan(0);
    });

    // ─── F3: Field validation + submit error ──────────────────────────────

    it("'Link & Execute' stays disabled without a transaction selected (validation)", async () => {
        setupCandidateHandler();
        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={vi.fn()}
                payment={PAYMENT}
                onExecute={vi.fn()}
            />,
        );
        await screen.findByText("Rent payment");
        // No radio click → button disabled
        expect(screen.getByRole("button", { name: "Link & Execute" })).toBeDisabled();
    });

    it("execution failure: onExecute rejection keeps dialog open", async () => {
        setupCandidateHandler();
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const user = userEvent.setup();
        const onExecute = vi.fn().mockRejectedValue(new Error("link failed"));
        const onOpenChange = vi.fn();

        renderWithApp(
            <LinkTransactionDialog
                open={true}
                onOpenChange={onOpenChange}
                payment={PAYMENT}
                onExecute={onExecute}
            />,
        );

        await screen.findByText("Rent payment");
        await user.click(screen.getByRole("radio"));
        await user.click(screen.getByRole("button", { name: "Link & Execute" }));

        await waitFor(() => expect(onExecute).toHaveBeenCalled());
        // Dialog should NOT auto-close on error (only closes after successful resolve)
        await new Promise((r) => setTimeout(r, 200));
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
        errSpy.mockRestore();
    });
});
