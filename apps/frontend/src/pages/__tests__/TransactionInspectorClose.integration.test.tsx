// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { transactionRow, transactionsBody } from "@/test/msw/rowFixtures";
import TransactionsPage from "@/pages/TransactionsPage";

vi.mock("@/hooks/useMediaQuery", () => ({
    useMediaQuery: (query: string) => query === "(min-width: 1024px)",
}));

// jsdom has no layout; expose rows while keeping the real table focus handlers.
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
function renderTransactionsPage() {
    return renderWithApp(
        <Routes>
            <Route path="/transactions" element={<TransactionsPage />} />
        </Routes>,
        { initialEntries: ["/transactions"] },
    );
}

describe("Transaction inspector dismissal (integration)", () => {
    it.each(["pointer", "keyboard", "Escape"])(
        "keeps the inspector closed after %s dismissal restores row focus",
        async (dismissal) => {
            server.use(
                http.get(`${API_BASE}/api/transactions`, () =>
                    ok(
                        transactionsBody({
                            items: [
                                transactionRow({
                                    id: 42,
                                    transaction_date: "2026-10-10",
                                    recipient_name: "Close test payee",
                                    amount: -25,
                                    bank_account: "Test account",
                                }),
                            ],
                        }),
                    ),
                ),
            );
            const user = userEvent.setup();
            renderTransactionsPage();
            const row = await screen.findByRole("row", {
                name: /Close test payee/,
            });
            act(() => row.focus());
            expect(
                await screen.findByRole("complementary", {
                    name: /transaction details/i,
                }),
            ).toBeInTheDocument();
            const close = screen.getByRole("button", { name: /^close$/i });
            if (dismissal === "pointer") {
                await user.click(close);
            } else {
                act(() => close.focus());
                await user.keyboard(
                    dismissal === "Escape" ? "{Escape}" : "{Enter}",
                );
            }
            await waitFor(() => expect(row).toHaveFocus());
            expect(
                screen.queryByRole("complementary", {
                    name: /transaction details/i,
                }),
            ).not.toBeInTheDocument();
            expect(row).toHaveAttribute("aria-selected", "false");
            await user.keyboard("{Enter}");
            expect(
                await screen.findByRole("complementary", {
                    name: /transaction details/i,
                }),
            ).toBeInTheDocument();
        },
    );
});

describe("Quick Look dismissal (integration)", () => {
    it.each(["Space", "Escape", "pointer"])(
        "restores focus without opening the inspector after %s",
        async (dismissal) => {
            server.use(
                http.get(`${API_BASE}/api/transactions`, () =>
                    ok(
                        transactionsBody({
                            items: [
                                transactionRow({
                                    id: 42,
                                    recipient_name: "Quick Look payee",
                                    amount: -25,
                                }),
                            ],
                        }),
                    ),
                ),
            );
            const user = userEvent.setup();
            renderTransactionsPage();
            const row = await screen.findByRole("row", {
                name: /Quick Look payee/,
            });
            act(() => row.focus());
            await screen.findByRole("complementary", {
                name: /transaction details/i,
            });
            await user.click(screen.getByRole("button", { name: /^close$/i }));
            await waitFor(() => expect(row).toHaveFocus());
            await user.keyboard(" ");
            await screen.findByRole("dialog", { name: /quick look/i });
            if (dismissal === "pointer")
                await user.click(
                    screen.getByRole("button", { name: /^close$/i }),
                );
            else await user.keyboard(dismissal === "Escape" ? "{Escape}" : " ");
            await waitFor(() =>
                expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
            );
            await waitFor(() => expect(row).toHaveFocus());
            expect(
                screen.queryByRole("complementary", {
                    name: /transaction details/i,
                }),
            ).not.toBeInTheDocument();
            expect(row).toHaveAttribute("aria-selected", "false");
        },
    );
});
