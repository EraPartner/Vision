// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import type { Account } from "@/types/api";
import { CloseAccountDialog } from "../CloseAccountDialog";

const toastMocks = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
}));

vi.mock("sonner", () => ({
    toast: toastMocks,
}));

const API_BASE = "http://localhost:3002";
const sourceAccount = {
    id: 7,
    name: "Old Broker",
    display_name: "Old Broker",
    type: "brokerage",
    currency: "EUR",
    is_active: true,
    in_net_worth: true,
    computed_balance: 0,
} as Account;

function installPreview(count = 2, transactionIds = [11, 12]) {
    server.use(
        http.get(`${API_BASE}/api/accounts/7/portfolio-lot-retag-preview`, () =>
            ok({
                account_id: 7,
                eligible_count: count,
                transaction_ids: transactionIds,
                limit: 500,
                links: [],
            }),
        ),
        http.get(`${API_BASE}/api/accounts`, () =>
            ok({
                items: [
                    sourceAccount,
                    {
                        ...sourceAccount,
                        id: 8,
                        name: "New Broker",
                        display_name: "New Broker",
                    },
                ],
                total: 2,
                links: [],
            }),
        ),
    );
}

describe("CloseAccountDialog portfolio lots", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
            "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
        );
    });

    it("moves the exact reviewed lot rows before closing and prints the receipt count", async () => {
        const user = userEvent.setup();
        const calls: string[] = [];
        let retagBody: unknown;
        installPreview();
        server.use(
            http.put(
                `${API_BASE}/api/investments/transactions/broker`,
                async ({ request }) => {
                    calls.push("retag");
                    retagBody = await request.json();
                    return ok({ changed_count: 2 });
                },
            ),
            http.post(`${API_BASE}/api/accounts/7/close`, () => {
                calls.push("close");
                return ok({
                    account_id: 7,
                    balance_handling: "preserve",
                    already_closed: false,
                    adjustments: [],
                });
            }),
        );

        renderWithApp(
            <CloseAccountDialog
                account={sourceAccount}
                open
                onOpenChange={() => {}}
            />,
        );
        const dialog = await screen.findByRole("dialog");
        expect(
            await within(dialog).findByText(/2 lot transactions are assigned/i),
        ).toBeVisible();
        await user.click(
            await within(dialog).findByRole("combobox", {
                name: "Portfolio lot destination",
            }),
        );
        await user.click(
            await screen.findByRole("option", { name: "Move to Unassigned" }),
        );
        await user.click(
            within(dialog).getByRole("button", { name: "Close account" }),
        );

        await waitFor(() => expect(calls).toEqual(["retag", "close"]));
        expect(retagBody).toEqual({
            transaction_ids: [11, 12],
            from_account_id: 7,
            to_account_id: null,
            idempotency_key: "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
        });
        expect(toastMocks.success).toHaveBeenCalledWith(
            "Closed Old Broker",
            expect.objectContaining({
                description: "Moved 2 portfolio lot transactions.",
            }),
        );
    });

    it("does not close when the audited re-tag fails", async () => {
        const user = userEvent.setup();
        let closeCalls = 0;
        installPreview();
        server.use(
            http.put(`${API_BASE}/api/investments/transactions/broker`, () =>
                HttpResponse.json({ message: "stale" }, { status: 409 }),
            ),
            http.post(`${API_BASE}/api/accounts/7/close`, () => {
                closeCalls += 1;
                return ok({});
            }),
        );
        renderWithApp(
            <CloseAccountDialog
                account={sourceAccount}
                open
                onOpenChange={() => {}}
            />,
        );
        const dialog = await screen.findByRole("dialog");
        await user.click(
            await within(dialog).findByRole("combobox", {
                name: "Portfolio lot destination",
            }),
        );
        await user.click(
            await screen.findByRole("option", { name: "New Broker" }),
        );
        await user.click(
            within(dialog).getByRole("button", { name: "Close account" }),
        );

        await waitFor(() => expect(toastMocks.error).toHaveBeenCalled());
        expect(toastMocks.error.mock.calls.at(-1)?.[0]).toBe(
            "Could not close account",
        );
        expect(closeCalls).toBe(0);
    });

    it("never submits a partial over-limit re-tag and still allows keeping lots", async () => {
        const user = userEvent.setup();
        let retagCalls = 0;
        let closeCalls = 0;
        installPreview(501, []);
        server.use(
            http.put(`${API_BASE}/api/investments/transactions/broker`, () => {
                retagCalls += 1;
                return ok({});
            }),
            http.post(`${API_BASE}/api/accounts/7/close`, () => {
                closeCalls += 1;
                return ok({
                    account_id: 7,
                    balance_handling: "preserve",
                    already_closed: false,
                    adjustments: [],
                });
            }),
        );
        renderWithApp(
            <CloseAccountDialog
                account={sourceAccount}
                open
                onOpenChange={() => {}}
            />,
        );
        const dialog = await screen.findByRole("dialog");
        expect(await within(dialog).findByText(/more than 500/i)).toBeVisible();
        await user.click(
            within(dialog).getByRole("button", { name: "Close account" }),
        );
        await waitFor(() => expect(closeCalls).toBe(1));
        expect(retagCalls).toBe(0);
    });

    it("reports a moved-lots partial state when closing fails", async () => {
        const user = userEvent.setup();
        installPreview();
        server.use(
            http.put(`${API_BASE}/api/investments/transactions/broker`, () =>
                ok({ changed_count: 2 }),
            ),
            http.post(`${API_BASE}/api/accounts/7/close`, () =>
                HttpResponse.json({ message: "down" }, { status: 500 }),
            ),
        );
        renderWithApp(
            <CloseAccountDialog
                account={sourceAccount}
                open
                onOpenChange={() => {}}
            />,
        );
        const dialog = await screen.findByRole("dialog");
        await user.click(
            await within(dialog).findByRole("combobox", {
                name: "Portfolio lot destination",
            }),
        );
        await user.click(
            await screen.findByRole("option", { name: "New Broker" }),
        );
        await user.click(
            within(dialog).getByRole("button", { name: "Close account" }),
        );

        await waitFor(() =>
            expect(toastMocks.error).toHaveBeenCalledWith(
                "Portfolio lots moved, but the account stayed open",
                expect.objectContaining({
                    description: expect.stringMatching(/2 lot transactions/i),
                }),
            ),
        );
    });
});
