// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import en from "@/locales/en";
import { BulkActionsBar, type BulkSelectionMode } from "../BulkActionsBar";
import type { ExistingTransferLeg } from "@/features/transactions/hooks/useMarkTransfer";

const labels = en as Record<string, string>;
const API_BASE = "http://localhost:3002";
const outflow: ExistingTransferLeg = {
    id: 1,
    accountId: 10,
    bank: "Synthetic bank",
    date: "2025-01-02",
    amount: -10,
    currency: "EUR",
    is_active: true,
};
const inflow: ExistingTransferLeg = {
    id: 2,
    accountId: 11,
    bank: "Synthetic broker",
    date: "2025-01-03",
    amount: 9.8,
    currency: "EUR",
    is_active: true,
};

function bar(
    rows: ExistingTransferLeg[],
    mode: BulkSelectionMode = "ids",
    onClearSelection = vi.fn(),
    ids = rows.map((row) => row.id),
) {
    return (
        <BulkActionsBar
            selectedIds={new Set(ids)}
            selectedTransactions={rows}
            selectionMode={mode}
            totalMatching={20}
            visibleItemCount={rows.length}
            filter={{}}
            onClearSelection={onClearSelection}
            onPromoteToFilterMode={vi.fn()}
        />
    );
}
async function openActions(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
        await screen.findByRole("button", {
            name: labels["txPage.bulk.actions"],
        }),
    );
}

describe("pairing existing transfer records", () => {
    it.each([false, true])(
        "confirms the two records before linking unequal amounts (cross currency = %s) and creates no cash rows",
        async (crossCurrency) => {
            const selectedInflow = {
                ...inflow,
                currency: crossCurrency ? "USD" : "EUR",
            };
            const requests: unknown[] = [];
            const createRecord = vi.fn();
            const clear = vi.fn();
            server.use(
                http.post(
                    `${API_BASE}/api/transactions/transfers`,
                    async ({ request }) => {
                        requests.push(await request.json());
                        return ok({ ok: true });
                    },
                ),
                http.post(`${API_BASE}/api/transactions`, () => {
                    createRecord();
                    return ok({});
                }),
                http.post(`${API_BASE}/api/recipients`, () => {
                    createRecord();
                    return ok({});
                }),
            );
            const user = userEvent.setup();
            renderWithApp(bar([outflow, selectedInflow], "ids", clear));
            await openActions(user);
            await user.click(
                screen.getByRole("menuitem", {
                    name: labels["txPage.bulk.markTransfer"],
                }),
            );
            const dialog = await screen.findByRole("alertdialog");
            for (const value of [
                "Synthetic bank",
                "Synthetic broker",
                "2025-01-02",
                "2025-01-03",
                "-10",
                "9.8",
                "EUR",
                selectedInflow.currency,
            ])
                expect(dialog).toHaveTextContent(value);
            expect(requests).toHaveLength(0);
            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(requests).toHaveLength(0);
            await openActions(user);
            await user.click(
                screen.getByRole("menuitem", {
                    name: labels["txPage.bulk.markTransfer"],
                }),
            );
            await user.click(
                await screen.findByRole("button", {
                    name: labels["txPage.bulk.markTransfer"],
                }),
            );
            await waitFor(() => expect(requests).toEqual([{ aId: 1, bId: 2 }]));
            await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
            expect(createRecord).not.toHaveBeenCalled();
        },
    );

    it.each([
        "filter",
        "one",
        "three",
        "missing",
        "missing_account",
        "same_account",
        "same_sign",
        "inactive",
        "zero",
        "paired",
    ] as const)("does not offer linking for %s selection", async (defect) => {
        let rows = [{ ...outflow }, { ...inflow }];
        let mode: BulkSelectionMode = "ids";
        if (defect === "filter") mode = "filter";
        if (defect === "one") rows = [rows[0]];
        if (defect === "three") rows.push({ ...inflow, id: 3 });
        if (defect === "same_account") rows[1].accountId = rows[0].accountId;
        if (defect === "missing_account") rows[1].accountId = undefined;
        if (defect === "same_sign") rows[1].amount = -9.8;
        if (defect === "inactive") rows[1].is_active = false;
        if (defect === "zero") rows[1].amount = 0;
        if (defect === "paired") rows[1].transferPeerId = 99;
        const ids = rows.map((row) => row.id);
        if (defect === "missing") rows.pop();
        const user = userEvent.setup();
        renderWithApp(bar(rows, mode, vi.fn(), ids));
        await openActions(user);
        expect(
            screen.queryByRole("menuitem", {
                name: labels["txPage.bulk.markTransfer"],
            }),
        ).not.toBeInTheDocument();
    });

    it("rejects confirmation after the selected financial data changes", async () => {
        const requests: unknown[] = [];
        server.use(
            http.post(
                `${API_BASE}/api/transactions/transfers`,
                async ({ request }) => {
                    requests.push(await request.json());
                    return ok({ ok: true });
                },
            ),
        );
        const user = userEvent.setup();
        const { rerender } = renderWithApp(bar([outflow, inflow]));
        await openActions(user);
        await user.click(
            screen.getByRole("menuitem", {
                name: labels["txPage.bulk.markTransfer"],
            }),
        );
        await screen.findByRole("alertdialog");
        rerender(bar([outflow, { ...inflow, amount: 5 }]));
        await user.click(
            screen.getByRole("button", {
                name: labels["txPage.bulk.markTransfer"],
            }),
        );
        await waitFor(() =>
            expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
        );
        expect(requests).toHaveLength(0);
    });
});
