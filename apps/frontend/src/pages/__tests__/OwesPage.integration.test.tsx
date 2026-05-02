// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import OwesPage from "@/pages/OwesPage";

const API_BASE = "http://localhost:3002";

/** A single recipient with one outstanding split. */
function owedSummaryWithRecipient() {
    return ok({
        items: [
            {
                recipient_id: 1,
                recipient_name: "Alice",
                total_owed: 50,
                total_paid: 10,
                remaining: 40,
                split_count: 1,
            },
        ],
    });
}

/** One unsettled split for recipient 1. */
function splitDetailForRecipient() {
    return ok({
        items: [
            {
                id: 101,
                transaction_id: 200,
                recipient_id: 1,
                recipient_name: "Alice",
                amount: 50,
                amount_paid: 10,
                note: "",
                is_settled: false,
                created_at: "2025-03-01T00:00:00.000Z",
                updated_at: "2025-03-01T00:00:00.000Z",
                transaction_date: "2025-03-01",
                transaction_memo: "Dinner",
                transaction_amount: 50,
                transaction_currency: "EUR",
                bank_account: "Main",
                remaining: 40,
            },
        ],
    });
}

describe("OwesPage (integration)", () => {
    it("renders page heading", async () => {
        renderWithApp(<OwesPage />);
        expect(
            await screen.findByRole("heading", { name: /who owes you/i }),
        ).toBeInTheDocument();
    });

    it("renders without crashing when no splits exist", async () => {
        renderWithApp(<OwesPage />);
        await screen.findByRole("heading", { name: /who owes you/i });
    });

    it("renders subtitle text", async () => {
        renderWithApp(<OwesPage />);
        expect(
            await screen.findByText(/track shared expenses and payments/i),
        ).toBeInTheDocument();
    });

    it("shows no-debts message when split list is empty", async () => {
        renderWithApp(<OwesPage />);
        // Default MSW returns { items: [] } — empty state paragraph
        expect(
            await screen.findByText(/no outstanding debts/i),
        ).toBeInTheDocument();
    });

    it("shows split-tracking hint when list is empty", async () => {
        renderWithApp(<OwesPage />);
        expect(
            await screen.findByText(/split a transaction to start tracking/i),
        ).toBeInTheDocument();
    });

    it("shows recipient card when splits exist", async () => {
        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
        );

        renderWithApp(<OwesPage />);

        expect(await screen.findByText("Alice")).toBeInTheDocument();
    });

    it("navigates to recipient detail and shows Record payment button when card is clicked", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
        );

        renderWithApp(<OwesPage />);

        // Click recipient card to enter RecipientOwesDetail
        await user.click(await screen.findByText("Alice"));

        // owesPage.recordPayment = "Record payment"
        expect(
            await screen.findByRole("button", { name: /record payment/i }),
        ).toBeInTheDocument();
    });

    it("opens Record Payment dialog when the icon button is clicked", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
        );

        renderWithApp(<OwesPage />);

        await user.click(await screen.findByText("Alice"));

        const recordBtn = await screen.findByRole("button", { name: /record payment/i });
        await user.click(recordBtn);

        // owesPage.recordDialog.title = "Record Payment"
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /^record payment$/i }),
        ).toBeInTheDocument();
    });

    it("Record Payment dialog has Amount input field", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
        );

        renderWithApp(<OwesPage />);

        await user.click(await screen.findByText("Alice"));
        await user.click(await screen.findByRole("button", { name: /record payment/i }));
        await screen.findByRole("dialog");

        // owesPage.recordDialog.placeholder = "Payment amount"
        expect(
            screen.getByPlaceholderText(/payment amount/i),
        ).toBeInTheDocument();
    });

    it("Record Payment dialog closes when Cancel is clicked", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
        );

        renderWithApp(<OwesPage />);

        await user.click(await screen.findByText("Alice"));
        await user.click(await screen.findByRole("button", { name: /record payment/i }));
        await screen.findByRole("dialog");

        // owesPage.recordDialog.cancel = "Cancel"
        await user.click(screen.getByRole("button", { name: /^cancel$/i }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows Settle all button in recipient detail view", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
        );

        renderWithApp(<OwesPage />);

        await user.click(await screen.findByText("Alice"));

        // owesPage.settleAll.button = "Settle all"
        expect(
            await screen.findByRole("button", { name: /settle all/i }),
        ).toBeInTheDocument();
    });

    it("shows Export CSV button in recipient detail view", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
        );

        renderWithApp(<OwesPage />);

        await user.click(await screen.findByText("Alice"));

        // owesPage.export.button = "Export CSV"
        expect(
            await screen.findByRole("button", { name: /export csv/i }),
        ).toBeInTheDocument();
    });

    it("Record Payment dialog closes when Escape is pressed", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
        );

        renderWithApp(<OwesPage />);

        await user.click(await screen.findByText("Alice"));
        await user.click(await screen.findByRole("button", { name: /record payment/i }));
        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("clicking Settle all shows confirmation dialog then fires POST /api/splits/owed/:id/settle-all", async () => {
        const user = userEvent.setup();
        let settleAllCalled = false;

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
            http.post(`${API_BASE}/api/splits/owed/1/settle-all`, () => {
                settleAllCalled = true;
                return ok({ settled_count: 1 });
            }),
        );

        renderWithApp(<OwesPage />);

        await user.click(await screen.findByText("Alice"));

        // Click the "Settle all" header button
        const settleAllBtn = await screen.findByRole("button", { name: /settle all/i });
        await user.click(settleAllBtn);

        // AlertDialog appears — role="alertdialog"
        // owesPage.settleAll.confirmTitle = "Settle all outstanding splits"
        expect(
            await screen.findByRole("alertdialog"),
        ).toBeInTheDocument();
        expect(
            await screen.findByText(/settle all outstanding splits/i),
        ).toBeInTheDocument();

        // Confirm — owesPage.settleAll.confirmAction = "Settle all"
        const confirmBtn = screen.getByRole("button", { name: /^settle all$/i });
        await user.click(confirmBtn);

        expect(settleAllCalled).toBe(true);
    });

    it("Back button navigates back to the recipient list", async () => {
        const user = userEvent.setup();

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
        );

        renderWithApp(<OwesPage />);

        // Navigate into the detail view
        await user.click(await screen.findByText("Alice"));
        // Detail view should have Export CSV and Record payment
        await screen.findByRole("button", { name: /record payment/i });

        // Click Back button (title = "Back" = common.back)
        await user.click(screen.getByRole("button", { name: /^back$/i }));

        // Main list heading is restored
        expect(
            await screen.findByRole("heading", { name: /who owes you/i }),
        ).toBeInTheDocument();
    });

    it("Export CSV shows success toast when download succeeds", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "success");

        // Stub blob URL helpers — jsdom does not implement them
        URL.createObjectURL = vi.fn(() => "blob:mock-url");
        URL.revokeObjectURL = vi.fn();

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1/export/csv`, () =>
                new HttpResponse("date,amount,recipient\n2025-03-01,50,Alice", {
                    status: 200,
                    headers: { "Content-Type": "text/csv" },
                }),
            ),
        );

        renderWithApp(<OwesPage />);

        // Navigate to recipient detail
        await user.click(await screen.findByText("Alice"));

        // Click Export CSV
        await user.click(await screen.findByRole("button", { name: /export csv/i }));

        // owesPage.export.success = "CSV exported"
        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith("CSV exported"),
        );
    });

    it("Export CSV shows error toast when download fails", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");

        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => owedSummaryWithRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1`, () => splitDetailForRecipient()),
            http.get(`${API_BASE}/api/splits/owed/1/export/csv`, () =>
                new HttpResponse(null, { status: 500 }),
            ),
        );

        renderWithApp(<OwesPage />);

        // Navigate to recipient detail
        await user.click(await screen.findByText("Alice"));

        // Click Export CSV
        await user.click(await screen.findByRole("button", { name: /export csv/i }));

        // owesPage.export.failed = "Failed to export CSV"
        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                "Failed to export CSV",
                expect.anything(),
            ),
        );
    });

    it("renders empty state gracefully when splits API fails with 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => err(500, "db unavailable")),
        );
        renderWithApp(<OwesPage />);
        expect(
            await screen.findByRole("heading", { name: /who owes you/i }),
        ).toBeInTheDocument();
        // apiRequest retries on 500 (MAX_RETRIES=2, ~1.5 s backoff) — needs extended timeout
        expect(
            await screen.findByText(/no outstanding debts/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("renders empty state gracefully when splits API fails with 403", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => err(403, "Forbidden")),
        );
        renderWithApp(<OwesPage />);
        expect(
            await screen.findByRole("heading", { name: /who owes you/i }),
        ).toBeInTheDocument();
        expect(await screen.findByText(/no outstanding debts/i)).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when splits/owed endpoint returns 404", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => err(404, "Not found")),
        );
        const { container } = renderWithApp(<OwesPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });

    it("after settle-all mutation, the splits list refetches (stale refetch)", async () => {
        let getOwedCalls = 0;
        let getDetailCalls = 0;
        server.use(
            http.get(`${API_BASE}/api/splits/owed`, () => {
                getOwedCalls += 1;
                return owedSummaryWithRecipient();
            }),
            http.get(`${API_BASE}/api/splits/owed/1`, () => {
                getDetailCalls += 1;
                return splitDetailForRecipient();
            }),
            http.post(`${API_BASE}/api/splits/owed/1/settle-all`, () =>
                ok({ settled_count: 1 }),
            ),
        );

        const user = userEvent.setup();
        renderWithApp(<OwesPage />);
        await user.click(await screen.findByText("Alice"));
        await screen.findByRole("button", { name: /settle all/i });

        const beforeOwed = getOwedCalls;
        const beforeDetail = getDetailCalls;

        const settleAllBtn = await screen.findByRole("button", { name: /settle all/i });
        await user.click(settleAllBtn);
        await screen.findByRole("alertdialog");
        const confirmBtn = screen.getByRole("button", { name: /^settle all$/i });
        await user.click(confirmBtn);

        // After settle-all, both queries should refetch
        await waitFor(() =>
            expect(getOwedCalls + getDetailCalls).toBeGreaterThan(beforeOwed + beforeDetail),
        );
    });
});
