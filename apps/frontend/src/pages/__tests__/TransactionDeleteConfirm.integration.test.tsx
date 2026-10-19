// @vitest-environment jsdom
/**
 * Deleting a transaction asks first. Undo re-creates the row without its
 * attachments, splits and planned-payment link (docs/features/transactions.md),
 * so the confirmation must stay until Undo can restore everything.
 */
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { http, HttpResponse } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { transactionRow, transactionsBody } from "@/test/msw/rowFixtures";
import TransactionsPage from "@/pages/TransactionsPage";

vi.mock("@/hooks/useMediaQuery", () => ({
    useMediaQuery: (query: string) => query === "(min-width: 1024px)",
}));

// jsdom has no layout; expose every row.
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({
        count,
        estimateSize,
    }: {
        count: number;
        estimateSize: () => number;
    }) => ({
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                key: index,
                index,
                start: index * estimateSize(),
                size: estimateSize(),
            })),
        getTotalSize: () => count * estimateSize(),
        measureElement: vi.fn(),
        scrollToIndex: vi.fn(),
    }),
}));

const API_BASE = "http://localhost:3002";

function setup() {
    const deletes: string[] = [];
    server.use(
        http.get(`${API_BASE}/api/transactions`, () =>
            ok(
                transactionsBody({
                    items: [
                        transactionRow({
                            id: 42,
                            transaction_date: "2026-10-10",
                            recipient_name: "Delete test payee",
                            memo: "Delete test memo",
                            amount: -25,
                            bank_account: "Test account",
                        }),
                    ],
                }),
            ),
        ),
        http.delete(`${API_BASE}/api/transactions/:id`, ({ params }) => {
            deletes.push(String(params.id));
            return new HttpResponse(null, { status: 204 });
        }),
    );
    renderWithApp(
        <Routes>
            <Route path="/transactions" element={<TransactionsPage />} />
        </Routes>,
        { initialEntries: ["/transactions"] },
    );
    return deletes;
}

async function openDeleteFromInspector(user: ReturnType<typeof userEvent.setup>) {
    const row = await screen.findByRole("row", { name: /Delete test payee/ });
    act(() => row.focus());
    const inspector = await screen.findByRole("complementary", {
        name: /transaction details/i,
    });
    await user.click(within(inspector).getByRole("button", { name: /^Delete/ }));
    return screen.findByRole("alertdialog");
}

describe("Transaction delete confirmation (integration)", () => {
    it("asks before deleting, warns what Undo cannot restore, and cancelling deletes nothing", async () => {
        const user = userEvent.setup();
        const deletes = setup();

        const dialog = await openDeleteFromInspector(user);
        expect(
            within(dialog).getByText("Delete transaction"),
        ).toBeInTheDocument();
        expect(dialog).toHaveTextContent(/attachments, splits and links/i);

        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await waitFor(() =>
            expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(deletes).toEqual([]);
    });

    it("deletes only after the destructive action is confirmed", async () => {
        const user = userEvent.setup();
        const deletes = setup();

        const dialog = await openDeleteFromInspector(user);
        expect(deletes).toEqual([]);
        await user.click(within(dialog).getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(deletes).toEqual(["42"]));
    });
});
