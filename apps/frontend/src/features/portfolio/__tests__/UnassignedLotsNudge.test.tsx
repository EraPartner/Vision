// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";

const mocks = vi.hoisted(() => ({
    bulkRetagTransactions: vi.fn(),
    completeHistory: [] as unknown[],
}));

vi.mock("@/hooks/useAccounts", () => ({
    useAccounts: () => ({
        data: {
            items: [
                {
                    id: 7,
                    name: "Broker",
                    display_name: "Degiro",
                    type: "brokerage",
                    is_active: true,
                },
            ],
        },
    }),
}));

vi.mock("@/hooks/portfolio/useInvestments", () => ({
    useAllPortfolioTransactionsQuery: () => ({
        data: mocks.completeHistory,
        isLoading: false,
        isError: false,
    }),
    useInvestmentMutations: () => ({
        bulkRetagTransactions: mocks.bulkRetagTransactions,
        isRetaggingTransactions: false,
    }),
}));

vi.mock("@/stores/hydration/LanguageHydration", () => ({
    LanguageHydration: ({ children }: { children: ReactNode }) => children,
    useLanguage: () => ({
        t: (key: string, vars: Record<string, string> = {}) => {
            const messages: Record<string, string> = {
                "portfolio.unassignedLots": "{count} unassigned portfolio lots",
                "portfolio.assignLots": "Assign lots",
                "portfolio.assignLotsBroker": "Destination broker",
                "portfolio.assignLotsReviewTitle": "Review broker assignment",
                "portfolio.assignLotsReviewDescription":
                    "Assign all {count} unassigned lots for {instrument} to {broker}?",
                "portfolio.assignLotsConfirm": "Assign all lots",
                "common.cancel": "Cancel",
            };
            return (messages[key] ?? key).replace(
                /\{(\w+)\}/g,
                (_, name: string) => vars[name] ?? `{${name}}`,
            );
        },
    }),
}));

import { UnassignedLotsNudge } from "../UnassignedLotsNudge";

const transaction = (id: number, accountId: number | null, investmentId = 4) =>
    ({
        id,
        investment_id: investmentId,
        account_id: accountId,
        type: "buy",
        date: "2026-01-01",
        amount: 10,
        currency: "EUR",
        is_recurring: false,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    }) as const;

describe("UnassignedLotsNudge", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.bulkRetagTransactions.mockResolvedValue({ changed_count: 2 });
        vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
            "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
        );
    });

    it("assigns every unassigned row for only the selected instrument in one request", async () => {
        const user = userEvent.setup();
        mocks.completeHistory = [
            transaction(12, null),
            transaction(11, null),
            transaction(13, 7),
            transaction(99, null, 5),
        ];
        renderWithApp(
            <UnassignedLotsNudge
                investmentId={4}
                investmentName="Example ETF"
                transactions={[
                    transaction(12, null),
                    transaction(11, null),
                    transaction(13, 7),
                    transaction(99, null, 5),
                ]}
            />,
        );

        expect(screen.getByText(/2 unassigned portfolio lots/i)).toBeVisible();
        expect(screen.getByText("Degiro")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Assign lots" }));
        expect(mocks.bulkRetagTransactions).not.toHaveBeenCalled();
        expect(
            screen.getByText(/2 unassigned lots for Example ETF to Degiro/i),
        ).toBeVisible();
        await user.click(
            screen.getByRole("button", { name: "Assign all lots" }),
        );

        expect(mocks.bulkRetagTransactions).toHaveBeenCalledWith({
            transaction_ids: [11, 12],
            from_account_id: null,
            to_account_id: 7,
            idempotency_key: "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
        });
    });

    it("does not render when the instrument has no unassigned rows", () => {
        mocks.completeHistory = [transaction(11, 7)];
        const { container } = renderWithApp(
            <UnassignedLotsNudge
                investmentId={4}
                investmentName="Example ETF"
                transactions={[transaction(11, 7)]}
            />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it("ignores unassigned non-lot income and adjustment rows", () => {
        mocks.completeHistory = [
            { ...transaction(11, null), type: "dividend" },
            { ...transaction(12, null), type: "fee" },
        ];
        const { container } = renderWithApp(
            <UnassignedLotsNudge
                investmentId={4}
                investmentName="Example ETF"
                transactions={[
                    { ...transaction(11, null), type: "dividend" },
                    { ...transaction(12, null), type: "fee" },
                ]}
            />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it("reuses the idempotency UUID when the same reviewed request is retried", async () => {
        const user = userEvent.setup();
        mocks.completeHistory = [transaction(11, null)];
        mocks.bulkRetagTransactions
            .mockRejectedValueOnce(new Error("ambiguous network failure"))
            .mockResolvedValueOnce({ changed_count: 1 });
        renderWithApp(
            <UnassignedLotsNudge
                investmentId={4}
                investmentName="Example ETF"
                transactions={[transaction(11, null)]}
            />,
        );

        for (let attempt = 0; attempt < 2; attempt += 1) {
            await user.click(
                screen.getByRole("button", { name: "Assign lots" }),
            );
            await user.click(
                screen.getByRole("button", { name: "Assign all lots" }),
            );
            await waitFor(() =>
                expect(mocks.bulkRetagTransactions).toHaveBeenCalledTimes(
                    attempt + 1,
                ),
            );
        }

        const keys = mocks.bulkRetagTransactions.mock.calls.map(
            ([payload]) => payload.idempotency_key,
        );
        expect(keys).toEqual([
            "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
            "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
        ]);
    });

    it("refuses to split an over-limit instrument into partial requests", () => {
        mocks.completeHistory = Array.from({ length: 501 }, (_, index) =>
            transaction(index + 1, null),
        );
        renderWithApp(
            <UnassignedLotsNudge
                investmentId={4}
                investmentName="Large ETF"
                transactions={Array.from({ length: 501 }, (_, index) =>
                    transaction(index + 1, null),
                )}
            />,
        );
        expect(
            screen.getByRole("button", { name: "Assign lots" }),
        ).toBeDisabled();
        expect(screen.getByText("portfolio.assignLotsOverLimit")).toBeVisible();
        expect(mocks.bulkRetagTransactions).not.toHaveBeenCalled();
    });
});
