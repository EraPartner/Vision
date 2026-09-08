// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import type { Account } from "@/types/api";
import { BrokerTransferDialog } from "../BrokerTransferDialog";

const API_BASE = "http://localhost:3002";
const source = {
    id: 7,
    name: "Old Broker",
    display_name: "Old Broker",
    type: "brokerage",
    currency: "EUR",
    is_active: true,
} as Account;

describe("BrokerTransferDialog", () => {
    beforeEach(() => {
        vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
            "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
        );
    });

    it("re-tags the complete selection and renders the immutable receipt", async () => {
        const user = userEvent.setup();
        let body: unknown;
        let closeRequests = 0;
        server.use(
            http.get(
                `${API_BASE}/api/accounts/7/portfolio-lot-retag-preview`,
                () =>
                    ok({
                        account_id: 7,
                        eligible_count: 2,
                        transaction_ids: [11, 12],
                        limit: 500,
                    }),
            ),
            http.get(`${API_BASE}/api/accounts`, () =>
                ok({
                    items: [
                        source,
                        {
                            ...source,
                            id: 8,
                            name: "New Broker",
                            display_name: "New Broker",
                        },
                    ],
                    total: 2,
                    links: [],
                }),
            ),
            http.put(
                `${API_BASE}/api/investments/transactions/broker`,
                async ({ request }) => {
                    body = await request.json();
                    return ok({
                        receipt_id: 42,
                        idempotency_key: "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
                        from_account_id: 7,
                        to_account_id: 8,
                        transaction_ids: [11, 12],
                        previous_assignments: [
                            { transaction_id: 11, account_id: 7 },
                            { transaction_id: 12, account_id: 7 },
                        ],
                        selected_count: 2,
                        changed_count: 2,
                        created_at: "2026-09-08T00:00:00Z",
                        replayed: false,
                    });
                },
            ),
            http.post(`${API_BASE}/api/accounts/7/close`, () => {
                closeRequests += 1;
                return ok({});
            }),
        );

        renderWithApp(
            <BrokerTransferDialog
                account={source}
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
        expect(
            screen.queryByRole("option", { name: "Old Broker" }),
        ).not.toBeInTheDocument();
        await user.click(
            await screen.findByRole("option", { name: "New Broker" }),
        );
        await user.click(
            within(dialog).getByRole("button", { name: "Transfer lots" }),
        );

        await waitFor(() =>
            expect(body).toEqual({
                transaction_ids: [11, 12],
                from_account_id: 7,
                to_account_id: 8,
                idempotency_key: "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
            }),
        );
        expect(
            await within(dialog).findByText("Transfer receipt"),
        ).toBeVisible();
        expect(
            within(dialog).getByText("2 lot transactions moved."),
        ).toBeVisible();
        expect(within(dialog).getByText("Receipt #42")).toBeVisible();
        expect(closeRequests).toBe(0);
    });

    it("reuses the idempotency key when an ambiguous transfer is retried", async () => {
        const user = userEvent.setup();
        const keys: unknown[] = [];
        let attempt = 0;
        server.use(
            http.get(
                `${API_BASE}/api/accounts/7/portfolio-lot-retag-preview`,
                () =>
                    ok({
                        account_id: 7,
                        eligible_count: 1,
                        transaction_ids: [11],
                        limit: 500,
                    }),
            ),
            http.get(`${API_BASE}/api/accounts`, () =>
                ok({ items: [source], total: 1, links: [] }),
            ),
            http.put(
                `${API_BASE}/api/investments/transactions/broker`,
                async ({ request }) => {
                    const body = (await request.json()) as Record<
                        string,
                        unknown
                    >;
                    keys.push(body.idempotency_key);
                    attempt += 1;
                    if (attempt === 1) return err(503, "Result unknown");
                    return ok({
                        receipt_id: 43,
                        idempotency_key: body.idempotency_key,
                        from_account_id: 7,
                        to_account_id: null,
                        transaction_ids: [11],
                        previous_assignments: [
                            { transaction_id: 11, account_id: 7 },
                        ],
                        selected_count: 1,
                        changed_count: 1,
                        created_at: "2026-09-08T00:00:00Z",
                        replayed: true,
                    });
                },
            ),
        );

        renderWithApp(
            <BrokerTransferDialog
                account={source}
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
            await screen.findByRole("option", { name: "Move to Unassigned" }),
        );

        const transfer = within(dialog).getByRole("button", {
            name: "Transfer lots",
        });
        await user.click(transfer);
        await waitFor(() => expect(keys).toHaveLength(2));
        expect(keys).toEqual([
            "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
            "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
        ]);
        expect(await within(dialog).findByText("Receipt #43")).toBeVisible();
    });

    it("fails closed while the preview is loading", async () => {
        server.use(
            http.get(
                `${API_BASE}/api/accounts/7/portfolio-lot-retag-preview`,
                async () => {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    return ok({
                        account_id: 7,
                        eligible_count: 0,
                        transaction_ids: [],
                        limit: 500,
                    });
                },
            ),
        );
        renderWithApp(
            <BrokerTransferDialog
                account={source}
                open
                onOpenChange={() => {}}
            />,
        );
        const dialog = await screen.findByRole("dialog");
        expect(
            within(dialog).getByText("Loading assigned portfolio lots…"),
        ).toBeVisible();
        expect(
            within(dialog).getByRole("button", { name: "Transfer lots" }),
        ).toBeDisabled();
    });

    it.each([
        [
            "an unavailable preview",
            () => err(503, "Unavailable"),
            /selection is unavailable/i,
        ],
        [
            "an empty preview",
            () =>
                ok({
                    account_id: 7,
                    eligible_count: 0,
                    transaction_ids: [],
                    limit: 500,
                }),
            /no assigned portfolio lots/i,
        ],
    ])("fails closed for %s", async (_label, response, message) => {
        server.use(
            http.get(
                `${API_BASE}/api/accounts/7/portfolio-lot-retag-preview`,
                response,
            ),
        );
        renderWithApp(
            <BrokerTransferDialog
                account={source}
                open
                onOpenChange={() => {}}
            />,
        );
        const dialog = await screen.findByRole("dialog");
        expect(await within(dialog).findByText(message)).toBeVisible();
        expect(
            within(dialog).getByRole("button", { name: "Transfer lots" }),
        ).toBeDisabled();
    });

    it("refuses to split an over-limit transfer", async () => {
        server.use(
            http.get(
                `${API_BASE}/api/accounts/7/portfolio-lot-retag-preview`,
                () =>
                    ok({
                        account_id: 7,
                        eligible_count: 501,
                        transaction_ids: [],
                        limit: 500,
                    }),
            ),
        );
        renderWithApp(
            <BrokerTransferDialog
                account={source}
                open
                onOpenChange={() => {}}
            />,
        );
        const dialog = await screen.findByRole("dialog");
        expect(await within(dialog).findByText(/more than 500/i)).toBeVisible();
        expect(
            within(dialog).getByRole("button", { name: "Transfer lots" }),
        ).toBeDisabled();
    });
});
