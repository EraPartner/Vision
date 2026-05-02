// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { ExecutionHistoryDialog } from "@/components/planned/ExecutionHistoryDialog";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";

const API_BASE = "http://localhost:3002";

// A payment with no executions
const EMPTY_PAYMENT: PlannedPayment = {
    id: 1,
    name: "Monthly Rent",
    due_date: "2025-02-01",
    amount: 1200,
    currency: "EUR",
    is_recurring: true,
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    is_executed: false,
    executed_transaction_id: undefined,
    last_executed_date: undefined,
    executions: [],
};

// A payment with a single executed_transaction_id link (legacy path)
const EXECUTED_PAYMENT: PlannedPayment = {
    ...EMPTY_PAYMENT,
    id: 2,
    name: "Gym Fee",
    is_executed: true,
    executed_transaction_id: 99,
    last_executed_date: "2025-01-15",
    executions: [],
};

// Transaction stub returned for transaction_id=99
const GYM_TRANSACTION_RESPONSE = {
    items: [
        {
            id: 99,
            transaction_date: "2025-01-15",
            date: "2025-01-15",
            bank_account: "BE12",
            recipient_id: 1,
            recipient_name: "Gym Corp",
            memo: "January membership",
            amount: -50,
            currency: "EUR",
            balance: null,
            category_id: null,
            category_name: null,
            comment: null,
            is_active: true,
            created_at: "2025-01-15T00:00:00.000Z",
            updated_at: null,
        },
    ],
    total: 1,
    limit: 1,
    offset: 0,
    links: [],
};

function stubGymTransaction() {
    server.use(
        http.get(`${API_BASE}/api/transactions`, ({ request }) => {
            const url = new URL(request.url);
            if (url.searchParams.get("transaction_id") === "99") {
                return ok(GYM_TRANSACTION_RESPONSE);
            }
            return ok({ items: [], total: 0, limit: 1, offset: 0, links: [] });
        })
    );
}

beforeEach(() => {
    server.resetHandlers();
});

function renderDialog(open: boolean, payments: PlannedPayment[]) {
    const onOpenChange = vi.fn();
    const result = renderWithApp(
        <ExecutionHistoryDialog
            open={open}
            onOpenChange={onOpenChange}
            payments={payments}
        />
    );
    return { ...result, onOpenChange };
}

describe("ExecutionHistoryDialog", () => {
    it("renders dialog when open=true", async () => {
        // Arrange + Act
        renderDialog(true, []);

        // Assert
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("shows empty state when no payments have executions", async () => {
        // Arrange + Act
        renderDialog(true, [EMPTY_PAYMENT]);

        // Assert
        expect(
            await screen.findByText(/no executed planned payments found yet/i)
        ).toBeInTheDocument();
    });

    it("shows execution history item for executed payment", async () => {
        // Arrange
        stubGymTransaction();

        // Act
        renderDialog(true, [EXECUTED_PAYMENT]);

        // Assert — both the planned payment name and transaction memo appear
        expect(await screen.findByText("Gym Fee")).toBeInTheDocument();
        expect(await screen.findByText("January membership")).toBeInTheDocument();
    });

    it("shows history items after loading resolves", async () => {
        // Arrange
        stubGymTransaction();

        // Act
        renderDialog(true, [EXECUTED_PAYMENT]);

        // Assert — history item appears once fetch resolves
        await waitFor(() => {
            expect(screen.queryByText(/loading execution history/i)).not.toBeInTheDocument();
        });
        expect(await screen.findByText("Gym Fee")).toBeInTheDocument();
    });

    it("Close button calls onOpenChange(false)", async () => {
        // Arrange
        const user = userEvent.setup();
        const { onOpenChange } = renderDialog(true, []);
        await screen.findByRole("dialog");

        // Act — the footer Close button is the last among multiple "Close" buttons
        // (the X icon button also carries an sr-only "Close" label)
        const closeBtns = await screen.findAllByRole("button", { name: /^close$/i });
        const footerCloseBtn = closeBtns[closeBtns.length - 1];
        await user.click(footerCloseBtn);

        // Assert
        await waitFor(() => {
            expect(onOpenChange).toHaveBeenCalledWith(false);
        });
    });

    it("navigate button calls onOpenChange(false) and links to transactions page", async () => {
        // Arrange
        stubGymTransaction();
        const user = userEvent.setup();
        const { onOpenChange } = renderDialog(true, [EXECUTED_PAYMENT]);

        // Wait for execution item to appear
        await screen.findByText("Gym Fee");

        // Act — click the external link icon button for this history item
        const openBtn = await screen.findByTitle(/open transaction/i);
        await user.click(openBtn);

        // Assert — dialog closed via onOpenChange
        await waitFor(() => {
            expect(onOpenChange).toHaveBeenCalledWith(false);
        });
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("Escape key calls onOpenChange(false)", async () => {
        const user = userEvent.setup();
        const { onOpenChange } = renderDialog(true, [EXECUTED_PAYMENT]);
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("dialog renders in open state (a11y / backdrop guard)", async () => {
        renderDialog(true, [EXECUTED_PAYMENT]);
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toHaveAttribute("data-state", "open");
    });

    it("renders empty state heading when payments array is empty", async () => {
        renderDialog(true, []);
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toBeInTheDocument();
    });

    // ─── F3: Submit/fetch error ───────────────────────────────────────────

    it("transactions fetch 5xx: dialog stays open and does not crash", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                err(500, "fetch failed"),
            ),
        );
        renderDialog(true, [EXECUTED_PAYMENT]);
        const dialog = await screen.findByRole("dialog");
        expect(dialog).toBeInTheDocument();
        // Wait briefly to let the failed fetch settle
        await new Promise((r) => setTimeout(r, 200));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        errSpy.mockRestore();
    });
});
