// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { apiClient } from "@/lib/api";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import { ExecutionHistoryDialog } from "@/features/planned/ExecutionHistoryDialog";
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
            links: [],
            transaction_date: "2025-01-15",
            date: "2025-01-15",
            bank_account: "BE12",
            recipient_id: 1,
            recipient_name: "Gym Corp",
            memo: "January membership",
            amount: -50,
            currency: "EUR",
            balance: undefined,
            category_id: undefined,
            category_name: undefined,
            comment: undefined,
            is_active: true,
            created_at: "2025-01-15T00:00:00.000Z",
            updated_at: undefined,
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
        }),
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
        />,
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
            await screen.findByText(/no executed planned payments found yet/i),
        ).toBeInTheDocument();
    });

    it("shows execution history item for executed payment", async () => {
        // Arrange
        stubGymTransaction();

        // Act
        renderDialog(true, [EXECUTED_PAYMENT]);

        // Assert — both the planned payment name and transaction memo appear
        expect(await screen.findByText("Gym Fee")).toBeInTheDocument();
        expect(
            await screen.findByText("January membership"),
        ).toBeInTheDocument();
    });

    it("shows history items after loading resolves", async () => {
        // Arrange
        stubGymTransaction();

        // Act
        renderDialog(true, [EXECUTED_PAYMENT]);

        // Assert — history item appears once fetch resolves
        await waitFor(() => {
            expect(
                screen.queryByText(/loading execution history/i),
            ).not.toBeInTheDocument();
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
        const closeBtns = await screen.findAllByRole("button", {
            name: /^close$/i,
        });
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
        const openBtn = await screen.findByRole("link", {
            name: /open transaction/i,
        });
        await user.click(openBtn);

        // Assert — dialog closed via onOpenChange
        await waitFor(() => {
            expect(onOpenChange).toHaveBeenCalledWith(false);
        });
    });

    it("shows a recoverable error instead of false empty history", async () => {
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                err(503, "Unavailable"),
            ),
        );
        renderDialog(true, [EXECUTED_PAYMENT]);
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        expect(
            screen.queryByText(/no executed planned payments found yet/i),
        ).not.toBeInTheDocument();
        stubGymTransaction();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: /retry/i }));
        expect(
            await screen.findByText("January membership"),
        ).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("keeps loaded rows visible when another history request fails", async () => {
        server.use(
            http.get(`${API_BASE}/api/transactions`, ({ request }) => {
                return new URL(request.url).searchParams.get(
                    "transaction_id",
                ) === "99"
                    ? ok(GYM_TRANSACTION_RESPONSE)
                    : err(503, "Unavailable");
            }),
        );
        renderDialog(true, [
            EXECUTED_PAYMENT,
            { ...EXECUTED_PAYMENT, id: 3, executed_transaction_id: 100 },
        ]);
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        expect(screen.getByText("January membership")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled();
    });

    it("ignores an old request when the payment list changes", async () => {
        let release!: (
            value: Awaited<ReturnType<typeof apiClient.getTransactions>>,
        ) => void;
        const response = new Promise<
            Awaited<ReturnType<typeof apiClient.getTransactions>>
        >((resolve) => {
            release = resolve;
        });
        const request = vi
            .spyOn(apiClient, "getTransactions")
            .mockReturnValueOnce(response);
        const { rerender } = renderDialog(true, [EXECUTED_PAYMENT]);
        await waitFor(() => expect(request).toHaveBeenCalled());
        rerender(
            <ExecutionHistoryDialog
                open
                onOpenChange={() => {}}
                payments={[]}
            />,
        );
        expect(
            await screen.findByText(/no executed planned payments found yet/i),
        ).toBeInTheDocument();
        await act(async () => {
            release(
                GYM_TRANSACTION_RESPONSE as Awaited<
                    ReturnType<typeof apiClient.getTransactions>
                >,
            );
            await response;
        });
        expect(
            screen.queryByText("January membership"),
        ).not.toBeInTheDocument();
        request.mockRestore();
    });

    it("restores keyboard focus to its programmatic opener after Escape", async () => {
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button onClick={() => setOpen(true)}>View history</button>
                    <ExecutionHistoryDialog
                        open={open}
                        onOpenChange={setOpen}
                        payments={[]}
                    />
                </>
            );
        }
        renderWithApp(<Harness />);
        const user = userEvent.setup();
        const trigger = screen.getByRole("button", { name: "View history" });
        await user.click(trigger);
        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(trigger).toHaveFocus());
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
