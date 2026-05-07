// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { TransactionInfoDialog } from "@/features/transactions/components/TransactionInfoDialog";
import type { TableTransaction } from "@/features/transactions/types";

const API_BASE = "http://localhost:3002";

const TX: TableTransaction = {
    id: 42,
    date: "2025-01-15",
    memo: "Test purchase",
    category: "FOOD:GROCERIES",
    categoryId: 1,
    recipient: "Alice",
    recipientId: 1,
    bank: "IBAN001",
    amount: -25.5,
    currency: "EUR",
    balance: 100,
    comment: "Test comment",
    is_active: true,
};

describe("TransactionInfoDialog", () => {
    beforeEach(() => {
        server.use(
            http.get(`${API_BASE}/api/attachments/transaction/:id`, () =>
                ok({ items: [] }),
            ),
        );
    });

    it("renders dialog when infoTransaction is provided", async () => {
        renderWithApp(
            <TransactionInfoDialog
                infoTransaction={TX}
                onClose={vi.fn()}
                onApplyLocal={vi.fn()}
            />,
        );

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        // txPage.detailsTitle = "Transaction Details" — findByRole waits for async i18n load
        expect(await screen.findByRole("heading", { name: /transaction details/i })).toBeInTheDocument();
    });

    it("does not render dialog when infoTransaction is null", () => {
        renderWithApp(
            <TransactionInfoDialog
                infoTransaction={null}
                onClose={vi.fn()}
                onApplyLocal={vi.fn()}
            />,
        );

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows transaction ID value", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");
        expect(screen.getByText("42")).toBeInTheDocument();
    });

    it("shows memo (description) value", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");
        expect(screen.getByText("Test purchase")).toBeInTheDocument();
    });

    it("shows recipient value", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");
        expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    it("shows category value", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");
        expect(screen.getByText("FOOD:GROCERIES")).toBeInTheDocument();
    });

    it("shows comment value", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");
        expect(screen.getByText("Test comment")).toBeInTheDocument();
    });

    it("shows status as Active for an active transaction", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");
        // txPage.statusActive = "Active"
        expect(screen.getByText(/^active$/i)).toBeInTheDocument();
    });

    it("shows status as Inactive for an inactive transaction", async () => {
        const inactiveTx = { ...TX, is_active: false };

        renderWithApp(
            <TransactionInfoDialog infoTransaction={inactiveTx} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");
        // txPage.statusInactive = "Inactive"
        expect(screen.getByText(/^inactive$/i)).toBeInTheDocument();
    });

    it("shows Edit pencil buttons for editable fields", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");
        // common.edit = "Edit" — title attribute provides accessible name for icon buttons
        const editButtons = screen.getAllByRole("button", { name: /^edit$/i });
        expect(editButtons.length).toBeGreaterThan(0);
    });

    it("clicking Edit on memo field shows text input", async () => {
        const user = userEvent.setup();

        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");

        // Edit buttons in DOM order: date (index 0), memo (index 1), amount, currency, bank, balance, comment
        const editButtons = screen.getAllByRole("button", { name: /^edit$/i });
        await user.click(editButtons[1]); // memo field uses editType="text"

        expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("Cancel button in edit mode exits edit mode", async () => {
        const user = userEvent.setup();

        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");

        const editButtons = await screen.findAllByRole("button", { name: /^edit$/i });
        await user.click(editButtons[1]); // memo
        expect(screen.getByRole("textbox")).toBeInTheDocument();

        // common.cancel = "Cancel"
        await user.click(await screen.findByRole("button", { name: /^cancel$/i }));

        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("Save button calls PATCH /api/transactions/:id and onApplyLocal", async () => {
        const user = userEvent.setup();
        const onApplyLocal = vi.fn();
        let patchCalled = false;

        server.use(
            http.patch(`${API_BASE}/api/transactions/42`, () => {
                patchCalled = true;
                return ok({ id: 42, memo: "New memo", amount: -25.5, currency: "EUR", is_active: true });
            }),
        );

        renderWithApp(
            <TransactionInfoDialog
                infoTransaction={TX}
                onClose={vi.fn()}
                onApplyLocal={onApplyLocal}
            />,
        );

        await screen.findByRole("dialog");

        const editButtons = await screen.findAllByRole("button", { name: /^edit$/i });
        await user.click(editButtons[1]); // memo

        const input = screen.getByRole("textbox");
        await user.clear(input);
        await user.type(input, "New memo");

        // common.save = "Save"
        await user.click(await screen.findByRole("button", { name: /^save$/i }));

        await waitFor(() => expect(patchCalled).toBe(true));
        await waitFor(() =>
            expect(onApplyLocal).toHaveBeenCalledWith(42, "memo", "New memo"),
        );
        // Edit mode exits after save
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("Escape key closes dialog and calls onClose", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();

        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={onClose} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        // Controlled component — onClose signals parent to clear infoTransaction prop;
        // dialog stays open in this test since we can't update the prop via a mock.
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("shows Attachments section", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");
        // txPage.attachments = "Attachments"
        expect(await screen.findByText(/attachments/i)).toBeInTheDocument();
    });

    it("shows no-attachments message when attachment list is empty", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );

        await screen.findByRole("dialog");
        // txPage.noAttachments = "No attachments yet"
        expect(await screen.findByText(/no attachments yet/i)).toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("first focusable element exists for keyboard nav", async () => {
        renderWithApp(
            <TransactionInfoDialog infoTransaction={TX} onClose={vi.fn()} onApplyLocal={vi.fn()} />,
        );
        await screen.findByRole("dialog");
        const buttons = screen.getAllByRole("button");
        expect(buttons.length).toBeGreaterThan(0);
    });

    // ─── F3: Field validation ──────────────────────────────────────────────

    it("starting edit then Cancel does NOT call PATCH (no submission)", async () => {
        const user = userEvent.setup();
        let patchCalled = false;

        server.use(
            http.patch(`${API_BASE}/api/transactions/42`, () => {
                patchCalled = true;
                return ok({ id: 42, memo: "x", amount: -25.5, currency: "EUR", is_active: true });
            }),
        );

        renderWithApp(
            <TransactionInfoDialog
                infoTransaction={TX}
                onClose={vi.fn()}
                onApplyLocal={vi.fn()}
            />,
        );

        await screen.findByRole("dialog");

        const editButtons = screen.getAllByRole("button", { name: /^edit$/i });
        await user.click(editButtons[1]); // memo

        await user.type(screen.getByRole("textbox"), " (changed)");
        await user.click(screen.getByRole("button", { name: /^cancel$/i }));

        await new Promise((r) => setTimeout(r, 100));
        expect(patchCalled).toBe(false);
    });
});
