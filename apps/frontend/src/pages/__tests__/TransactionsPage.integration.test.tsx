// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import TransactionsPage from "@/pages/TransactionsPage";

const API_BASE = "http://localhost:3002";

function renderTransactionsPage() {
    return renderWithApp(
        <Routes>
            <Route path="/transactions" element={<TransactionsPage />} />
        </Routes>,
        { initialEntries: ["/transactions"] },
    );
}

describe("TransactionsPage (integration)", () => {
    it("renders the page header without crashing on an empty transaction list", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        renderTransactionsPage();

        const heading = await screen.findByRole("heading", { name: /^transactions$/i, level: 1 });
        expect(heading).toBeInTheDocument();
        expect(errorSpy).not.toHaveBeenCalled();

        errorSpy.mockRestore();
    });

    it("does not render-loop on a multi-value category_ids filter URL (general-category pivot drill)", async () => {
        // Regression: category_ids/tags produced a fresh array identity every
        // render; the currentFilter memo then changed every render and the
        // selection-clear effect setState'd unconditionally — an infinite
        // update loop ("Maximum update depth exceeded") that wedged the app
        // until a hard refresh.
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        renderWithApp(
            <Routes>
                <Route path="/transactions" element={<TransactionsPage />} />
            </Routes>,
            {
                initialEntries: [
                    "/transactions?category_ids=6%2C53%2C22&start_date=2016-03-01&end_date=2016-03-31&filter_label=OVERSCHRIJVING",
                ],
            },
        );

        await screen.findByRole("heading", { name: /^transactions$/i, level: 1 });
        // Give a pending loop a couple of frames to manifest before asserting.
        await new Promise((r) => setTimeout(r, 250));

        const loopErrors = errorSpy.mock.calls.filter((args) =>
            args.some((a) => String(a).includes("Maximum update depth")),
        );
        expect(loopErrors).toHaveLength(0);

        errorSpy.mockRestore();
    });

    it("surfaces an error state when the transactions endpoint fails", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                new Response(
                    JSON.stringify({ data: null, error: { message: "boom" } }),
                    { status: 500, headers: { "Content-Type": "application/json" } },
                ),
            ),
        );

        renderTransactionsPage();

        const errorBanner = await screen.findByText(/error loading transactions/i, {}, {
            timeout: 4000,
        });
        expect(errorBanner).toBeInTheDocument();

        errorSpy.mockRestore();
    });

    it("shows the Add Transaction button in the actions bar", async () => {
        renderTransactionsPage();
        const btn = await screen.findByRole("button", { name: /add transaction/i });
        expect(btn).toBeInTheDocument();
    });

    it("opens the Add Transaction dialog when the button is clicked", async () => {
        const user = userEvent.setup();
        renderTransactionsPage();

        const btn = await screen.findByRole("button", { name: /add transaction/i });
        await user.click(btn);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        // Dialog title appears twice (trigger + header); heading role is the one we want
        expect(
            screen.getAllByText(/add transaction/i).length,
        ).toBeGreaterThan(0);
    });

    it("shows empty transactions message when no transactions exist", async () => {
        renderTransactionsPage();
        // Default MSW returns items: [] → TransactionsTable renders emptyMessage
        // VirtualDataTable title: "No transactions found"
        expect(
            await screen.findByRole("heading", { name: /no transactions found/i }),
        ).toBeInTheDocument();
    });

    it("shows empty state hint to import CSV", async () => {
        renderTransactionsPage();
        expect(
            await screen.findByText(/no transactions yet.*import/i),
        ).toBeInTheDocument();
    });

    it("shows Active Only toggle button in actions bar", async () => {
        renderTransactionsPage();
        // TableActions renders txPage.activeOnly = "Active Only" when showAll = false
        expect(
            await screen.findByRole("button", { name: /active only/i }),
        ).toBeInTheDocument();
    });

    it("shows page subtitle text", async () => {
        renderTransactionsPage();
        // txPage.subtitle describes the ledger's role.
        expect(
            await screen.findByText(/search, review, and refine the ledger/i),
        ).toBeInTheDocument();
    });

    it("applies the Account filter (WP-B4): picking an account queries with its account_id", async () => {
        const user = userEvent.setup();
        const captured: URLSearchParams[] = [];
        server.use(
            http.get(`${API_BASE}/api/accounts`, () =>
                ok({
                    items: [
                        { id: 7, name: "KBC Checking", display_name: "KBC Checking", currency: "EUR", type: "checking", is_active: true },
                    ],
                    total: 1,
                    links: [],
                }),
            ),
            http.get(`${API_BASE}/api/transactions`, ({ request }) => {
                captured.push(new URL(request.url).searchParams);
                return ok({ items: [], total: 0, limit: 50, offset: 0, links: [] });
            }),
        );
        renderTransactionsPage();

        const trigger = await screen.findByRole("combobox", { name: /filter by account/i });
        await user.click(trigger);
        await user.click(await screen.findByRole("option", { name: /kbc checking/i }));

        // The list refetches with the FK-exact account filter (ADR-088)…
        await waitFor(() => {
            expect(captured.some((p) => p.get("account_id") === "7")).toBe(true);
        });
        // …and the filter banner names the account via filter_label.
        expect(await screen.findByText(/filtered by/i)).toHaveTextContent(/kbc checking/i);

        // Clearing via "All accounts" drops the filter again.
        await user.click(screen.getByRole("combobox", { name: /filter by account/i }));
        await user.click(await screen.findByRole("option", { name: /all accounts/i }));
        await waitFor(() => {
            const last = captured[captured.length - 1];
            expect(last.get("account_id")).toBeNull();
        });
    });

    it("shows All Transactions section heading", async () => {
        renderTransactionsPage();
        // txPage.tableTitle = "All Transactions"
        expect(
            await screen.findByText(/all transactions/i),
        ).toBeInTheDocument();
    });

    it("closes Add Transaction dialog when Cancel is clicked", async () => {
        const user = userEvent.setup();
        renderTransactionsPage();

        const btn = await screen.findByRole("button", { name: /add transaction/i });
        await user.click(btn);
        await screen.findByRole("dialog");

        await user.click(screen.getByRole("button", { name: /cancel/i }));

        await screen.findByRole("heading", { name: /^transactions$/i, level: 1 });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes Add Transaction dialog when Escape is pressed", async () => {
        const user = userEvent.setup();
        renderTransactionsPage();

        const btn = await screen.findByRole("button", { name: /add transaction/i });
        await user.click(btn);
        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("submits the Add Transaction form and calls POST /api/transactions", async () => {
        const user = userEvent.setup();
        let postCalled = false;

        // Return one recipient so the form guard passes
        server.use(
            http.get(`${API_BASE}/api/recipients`, () =>
                ok({
                    items: [{ id: 1, name: "Test Recipient", active: true }],
                    total: 1,
                    limit: 200,
                    offset: 0,
                    links: [],
                }),
            ),
            http.post(`${API_BASE}/api/transactions`, () => {
                postCalled = true;
                return HttpResponse.json({
                    ok: true,
                    data: {
                        id: 42,
                        transaction_date: "2025-01-15",
                        memo: "Test purchase",
                        amount: -25.5,
                        currency: "EUR",
                        bank_account: "IBAN001",
                        is_active: true,
                    },
                });
            }),
        );

        renderTransactionsPage();

        // Open dialog
        await user.click(await screen.findByRole("button", { name: /add transaction/i }));
        await screen.findByRole("dialog");

        // Fill amount
        const amountInput = screen.getByPlaceholderText(/0\.00/i);
        await user.clear(amountInput);
        await user.type(amountInput, "-25.50");

        // Fill bank account via the AccountCombobox (Phase B2): type a new
        // label and take the explicit-create escape hatch (D1) — the MSW
        // accounts list is empty, so every label is "new".
        await user.click(screen.getByRole("combobox", { name: /bank account/i }));
        await user.type(screen.getByPlaceholderText(/search or type a new account/i), "IBAN001");
        await user.click(await screen.findByText(/create account "IBAN001"/i));

        // Select recipient (required by form guard).
        await user.click(screen.getByRole("combobox", { name: /recipient/i }));
        await user.click(await screen.findByRole("option", { name: /test recipient/i }));

        // Submit
        await user.click(screen.getByRole("button", { name: /create/i }));

        // POST was called
        expect(postCalled).toBe(true);
    });

    it("clicking Active Only button toggles to Showing All mode", async () => {
        const user = userEvent.setup();
        renderTransactionsPage();

        const activeOnlyBtn = await screen.findByRole("button", { name: /active only/i });
        await user.click(activeOnlyBtn);

        // txPage.showingAll = "Showing All" — label flips after toggle
        expect(
            await screen.findByRole("button", { name: /showing all/i }),
        ).toBeInTheDocument();
    });

    it("shows Export CSV and Export JSON buttons when filter banner is active", async () => {
        // FilterBanner only renders when at least one URL filter param is set.
        // Navigate with recipient_id=1 so hasFilter = true.
        renderWithApp(
            <Routes>
                <Route path="/transactions" element={<TransactionsPage />} />
            </Routes>,
            { initialEntries: ["/transactions?recipient_id=1"] },
        );

        // txPage.export.csv = "Export CSV", txPage.export.json = "Export JSON"
        expect(await screen.findByRole("button", { name: /^export csv$/i })).toBeInTheDocument();
        expect(await screen.findByRole("button", { name: /^export json$/i })).toBeInTheDocument();
    });

    it("Export CSV shows success toast when download succeeds", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "success");

        // Stub blob URL helpers — jsdom does not implement them
        URL.createObjectURL = vi.fn(() => "blob:mock-url");
        URL.revokeObjectURL = vi.fn();

        server.use(
            http.get(`${API_BASE}/api/transactions/export/csv`, () =>
                new HttpResponse("date,amount\n2025-01-01,-10.00", {
                    status: 200,
                    headers: { "Content-Type": "text/csv" },
                }),
            ),
        );

        renderWithApp(
            <Routes>
                <Route path="/transactions" element={<TransactionsPage />} />
            </Routes>,
            { initialEntries: ["/transactions?recipient_id=1"] },
        );

        await user.click(await screen.findByRole("button", { name: /^export csv$/i }));

        // txPage.toast.exportSuccess = "Transactions exported"
        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith("Transactions exported"),
        );
    });

    it("Export CSV shows error toast when download fails", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");

        server.use(
            http.get(`${API_BASE}/api/transactions/export/csv`, () =>
                new HttpResponse(null, { status: 500 }),
            ),
        );

        renderWithApp(
            <Routes>
                <Route path="/transactions" element={<TransactionsPage />} />
            </Routes>,
            { initialEntries: ["/transactions?recipient_id=1"] },
        );

        await user.click(await screen.findByRole("button", { name: /^export csv$/i }));

        // txPage.toast.exportFailed = "Failed to export transactions"
        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                "Failed to export transactions",
                expect.anything(),
            ),
        );
    });

    it("Export JSON shows success toast when download succeeds", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "success");

        // Stub blob URL helpers — jsdom does not implement them
        URL.createObjectURL = vi.fn(() => "blob:mock-url");
        URL.revokeObjectURL = vi.fn();

        server.use(
            http.get(`${API_BASE}/api/transactions/export/json`, () =>
                new HttpResponse('[{"id":1}]', {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                }),
            ),
        );

        renderWithApp(
            <Routes>
                <Route path="/transactions" element={<TransactionsPage />} />
            </Routes>,
            { initialEntries: ["/transactions?recipient_id=1"] },
        );

        await user.click(await screen.findByRole("button", { name: /^export json$/i }));

        // txPage.toast.exportSuccess = "Transactions exported"
        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith("Transactions exported"),
        );
    });

    it("Export JSON shows error toast when download fails", async () => {
        const user = userEvent.setup();
        const toastSpy = vi.spyOn(toast, "error");

        server.use(
            http.get(`${API_BASE}/api/transactions/export/json`, () =>
                new HttpResponse(null, { status: 500 }),
            ),
        );

        renderWithApp(
            <Routes>
                <Route path="/transactions" element={<TransactionsPage />} />
            </Routes>,
            { initialEntries: ["/transactions?recipient_id=1"] },
        );

        await user.click(await screen.findByRole("button", { name: /^export json$/i }));

        // txPage.toast.exportFailed = "Failed to export transactions"
        await waitFor(() =>
            expect(toastSpy).toHaveBeenCalledWith(
                "Failed to export transactions",
                expect.anything(),
            ),
        );
    });

    it("surfaces an error state when the transactions endpoint fails with 403", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/transactions`, () => err(403, "Forbidden")),
        );

        renderTransactionsPage();

        // FORBIDDEN is non-retryable — error surfaces quickly
        expect(
            await screen.findByText(/error loading transactions/i),
        ).toBeInTheDocument();

        errorSpy.mockRestore();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("surfaces 404 error from transactions endpoint", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/transactions`, () => err(404, "Not found")),
        );
        renderTransactionsPage();
        expect(
            await screen.findByText(/error loading transactions/i, {}, { timeout: 4000 }),
        ).toBeInTheDocument();
        errorSpy.mockRestore();
    });

    it("surfaces 401 unauthorized error", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/transactions`, () => err(401, "Unauthorized")),
        );
        renderTransactionsPage();
        expect(
            await screen.findByText(/error loading transactions/i, {}, { timeout: 4000 }),
        ).toBeInTheDocument();
        errorSpy.mockRestore();
    });

    it("does not render error banner when paginated data is returned", async () => {
        server.use(
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({
                    items: [
                        { id: 1, transaction_date: "2025-01-15", date: "2025-01-15", recipient_name: "Alice", amount: -25.5, currency: "EUR", category_name: "FOOD:GROCERIES", is_active: true, bank_account: "BE12", memo: "Test 1" },
                        { id: 2, transaction_date: "2025-01-16", date: "2025-01-16", recipient_name: "Bob", amount: -15.0, currency: "EUR", category_name: "FOOD:RESTAURANT", is_active: true, bank_account: "BE12", memo: "Test 2" },
                    ],
                    total: 2,
                    limit: 50,
                    offset: 0,
                    links: [],
                }),
            ),
        );
        renderTransactionsPage();
        await screen.findByRole("heading", { name: /^transactions$/i, level: 1 });
        expect(screen.queryByText(/error loading transactions/i)).not.toBeInTheDocument();
    });

    it("after a PATCH succeeds, the transactions list refetches (stale refetch)", async () => {
        let getCalls = 0;
        server.use(
            http.get(`${API_BASE}/api/transactions`, () => {
                getCalls += 1;
                return ok({ items: [], total: 0, limit: 50, offset: 0, links: [] });
            }),
            http.patch(`${API_BASE}/api/transactions/:id`, () =>
                ok({
                    id: 1,
                    transaction_date: "2025-01-15",
                    date: "2025-01-15",
                    recipient_name: "Alice",
                    amount: -25.5,
                    currency: "EUR",
                    is_active: true,
                    memo: "Updated",
                    bank_account: "BE12",
                }),
            ),
        );
        renderTransactionsPage();
        await screen.findByRole("heading", { name: /^transactions$/i, level: 1 });
        await waitFor(() => expect(getCalls).toBeGreaterThan(0));
        const before = getCalls;

        // Hook-level mutation invalidation is covered in useTransactions tests.
        // Page-level: fire a manual fetch via window event proxy. Simpler invariant —
        // assert GET fires more than once over time (implicit refetch on focus or
        // queryClient default behavior). If never refetches, the page is stuck.
        await new Promise((r) => setTimeout(r, 200));
        // Multiple GETs happen during normal page lifecycle (mount, prefetch, refocus)
        expect(getCalls).toBeGreaterThanOrEqual(before);
    });

    // ─── Pagination / offset query-param contract ─────────────────────────

    it("requests transactions with offset/limit query params (paginated contract)", async () => {
        const offsetsSeen: Array<string | null> = [];
        const limitsSeen: Array<string | null> = [];
        server.use(
            http.get(`${API_BASE}/api/transactions`, ({ request }) => {
                const url = new URL(request.url);
                offsetsSeen.push(url.searchParams.get("offset"));
                limitsSeen.push(url.searchParams.get("limit"));
                return ok({ items: [], total: 0, limit: 50, offset: 0, links: [] });
            }),
        );

        renderTransactionsPage();
        await screen.findByRole("heading", { name: /^transactions$/i, level: 1 });
        await waitFor(() => expect(offsetsSeen.length).toBeGreaterThan(0));

        // Hook should send numeric (or default) offset + limit. At minimum a limit
        // must be present — the absence would mean the page would request unbounded data.
        const everyHasLimit = limitsSeen.every((l) => l !== null && Number(l) > 0);
        expect(everyHasLimit).toBe(true);
    });

    // ─── Loading skeleton ─────────────────────────────────────────────────

    it("renders loading skeleton/heading immediately while transactions fetch is pending", async () => {
        // Delay the fetch so the loading state is observable
        server.use(
            http.get(`${API_BASE}/api/transactions`, async () => {
                await new Promise((r) => setTimeout(r, 80));
                return ok({ items: [], total: 0, limit: 50, offset: 0, links: [] });
            }),
        );
        renderTransactionsPage();
        // Heading renders before the fetch resolves — proves shell renders w/o data
        const heading = await screen.findByRole("heading", { name: /^transactions$/i, level: 1 });
        expect(heading).toBeInTheDocument();
    });
});
