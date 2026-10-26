// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
    act,
    fireEvent,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, SPLIT_STUB } from "@/test/msw/handlers";
import {
    recipientRow,
    recipientsBody,
    transactionRow,
    transactionsBody,
} from "@/test/msw/rowFixtures";
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

describe("Single transaction split entry points", () => {
    it.each(["pointer", "keyboard"])(
        "splits from the row menu with %s and reloads saved splits",
        async (input) => {
            let saved = false;
            const requests: unknown[] = [];
            server.use(
                http.get(`${API_BASE}/api/transactions`, () =>
                    ok(
                        transactionsBody({
                            items: [
                                transactionRow({
                                    id: 42,
                                    transaction_date: "2026-10-10",
                                    recipient_name: "Dinner",
                                    amount: -100,
                                    bank_account: "Test account",
                                }),
                            ],
                        }),
                    ),
                ),
                http.get(`${API_BASE}/api/recipients`, () =>
                    ok(
                        recipientsBody({
                            items: [
                                recipientRow({ id: 1, name: "Split guest" }),
                            ],
                            limit: 1000,
                        }),
                    ),
                ),
                http.get(`${API_BASE}/api/splits/transaction/42`, () =>
                    ok({
                        items: saved
                            ? [
                                  {
                                      ...SPLIT_STUB,
                                      id: 5,
                                      transaction_id: 42,
                                      recipient_id: 1,
                                      recipient_name: "Split guest",
                                      amount: 100,
                                  },
                              ]
                            : [],
                        total: saved ? 1 : 0,
                    }),
                ),
                http.post(
                    `${API_BASE}/api/splits/batch`,
                    async ({ request }) => {
                        requests.push(await request.json());
                        saved = true;
                        return ok({ items: [], total: 0 });
                    },
                ),
            );
            const user = userEvent.setup();
            renderTransactionsPage();
            const row = await screen.findByRole("row", { name: /Dinner/ });
            const openMenu = async () => {
                if (input === "keyboard") {
                    act(() => row.focus());
                    // jsdom does not generate the browser contextmenu event from Shift+F10.
                    fireEvent.contextMenu(row);
                } else {
                    fireEvent.contextMenu(row);
                }
                const menuItem = await screen.findByRole("menuitem", {
                    name: /split transaction/i,
                });
                if (input === "keyboard") {
                    act(() => menuItem.focus());
                    await user.keyboard("{Enter}");
                } else {
                    await user.click(menuItem);
                }
            };
            await openMenu();
            const dialog = await screen.findByRole("dialog", {
                name: /split transaction/i,
            });
            expect(
                await within(dialog).findByText(/not split yet/i),
            ).toBeInTheDocument();
            await user.click(
                within(dialog).getByRole("radio", { name: /others pay all/i }),
            );
            await user.click(within(dialog).getByRole("combobox"));
            await user.click(
                await screen.findByRole("option", { name: /split guest/i }),
            );
            await user.click(
                within(dialog).getByRole("button", { name: /^split$/i }),
            );
            await waitFor(() =>
                expect(requests).toEqual([
                    {
                        transaction_id: 42,
                        splits: [{ recipient_id: 1, amount: 100 }],
                    },
                ]),
            );
            await waitFor(() =>
                expect(
                    screen.queryByRole("dialog", {
                        name: /split transaction/i,
                    }),
                ).not.toBeInTheDocument(),
            );
            await openMenu();
            expect(
                await screen.findByText(
                    /this transaction already has 1 split/i,
                ),
            ).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: /^cancel$/i }));
            await waitFor(() =>
                expect(
                    screen.queryByRole("dialog", {
                        name: /split transaction/i,
                    }),
                ).not.toBeInTheDocument(),
            );
        },
    );
});
