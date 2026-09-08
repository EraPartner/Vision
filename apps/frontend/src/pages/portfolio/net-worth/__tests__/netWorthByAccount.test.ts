import { describe, expect, it } from "vitest";
import { ACCOUNT_STUB } from "@/test/msw/handlers";
import type { Account } from "@/types/api";
import type { PortfolioSummaryResponse } from "@/lib/api/info";
import {
    buildNetWorthAccountRows,
    sumNetWorthAccountRows,
} from "../netWorthByAccount";

describe("net worth by account", () => {
    it("composes included cash with every live holdings partition and Unassigned", () => {
        const accounts = [
            {
                ...ACCOUNT_STUB,
                id: 1,
                name: "Cash",
                display_name: "Cash",
                computed_balance: 1000,
            },
            {
                ...ACCOUNT_STUB,
                id: 2,
                name: "Broker",
                display_name: "Broker",
                type: "brokerage",
                computed_balance: 100,
            },
            {
                ...ACCOUNT_STUB,
                id: 3,
                name: "Wallet",
                display_name: "Wallet",
                type: "wallet",
                computed_balance: 999,
            },
            {
                ...ACCOUNT_STUB,
                id: 4,
                name: "Tracking broker",
                display_name: "Tracking broker",
                type: "brokerage",
                in_net_worth: false,
                computed_balance: 400,
            },
            {
                ...ACCOUNT_STUB,
                id: 5,
                name: "Mortgage",
                display_name: "Mortgage",
                type: "liability",
                computed_balance: -150,
            },
        ] as unknown as Account[];
        const summary = {
            currency: "EUR",
            computed_at: "2026-09-08T00:00:00Z",
            totals: { totalPortfolioValue: 1050 },
            summaries: [],
            byAccount: [
                { account_id: 2, currentValue: 500 },
                { account_id: 3, currentValue: 300 },
                { account_id: 4, currentValue: 200 },
                { account_id: null, currentValue: 50 },
            ].map((row) => ({
                ...row,
                assignment: row.account_id == null ? "unassigned" : "account",
                contribution_kind: "position",
                oversold: false,
                totalInvested: 0,
                realizedGain: 0,
                unrealizedGain: 0,
                gainLoss: 0,
            })),
        } as unknown as PortfolioSummaryResponse;

        const rows = buildNetWorthAccountRows(
            accounts,
            summary,
            (amount) => amount,
            "Unassigned",
        );
        if (!rows) throw new Error("expected complete FX conversion");

        expect(
            rows.map(({ label, cash, holdings, total }) => ({
                label,
                cash,
                holdings,
                total,
            })),
        ).toEqual([
            { label: "Broker", cash: 100, holdings: 500, total: 600 },
            { label: "Cash", cash: 1000, holdings: 0, total: 1000 },
            { label: "Mortgage", cash: -150, holdings: 0, total: -150 },
            { label: "Tracking broker", cash: 0, holdings: 200, total: 200 },
            { label: "Wallet", cash: 0, holdings: 300, total: 300 },
            { label: "Unassigned", cash: 0, holdings: 50, total: 50 },
        ]);
        expect(sumNetWorthAccountRows(rows)).toBe(2000);
    });

    it("fails closed when a cash currency cannot be converted", () => {
        const accounts = [
            {
                ...ACCOUNT_STUB,
                id: 1,
                currency: "USD",
                computed_balance: 100,
            },
        ] as unknown as Account[];
        const summary = {
            byAccount: [],
        } as unknown as PortfolioSummaryResponse;

        expect(
            buildNetWorthAccountRows(
                accounts,
                summary,
                () => undefined,
                "Unassigned",
            ),
        ).toBeUndefined();
    });
});
