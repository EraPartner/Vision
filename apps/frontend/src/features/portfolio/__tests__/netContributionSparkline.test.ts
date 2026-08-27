import { describe, expect, it, vi } from "vitest";
import { buildNetContributionSparkline } from "@/features/portfolio/netContributionSparkline";
import type { PortfolioTransaction } from "@/types/api";

function transaction(
    id: number,
    type: PortfolioTransaction["type"],
    date: string,
    amount: number,
    investmentId = 1,
): PortfolioTransaction {
    return {
        id,
        investment_id: investmentId,
        type,
        date,
        amount,
        currency: "USD",
        is_recurring: false,
        created_at: "2026-08-26T00:00:00Z",
        updated_at: "2026-08-26T00:00:00Z",
    };
}

describe("buildNetContributionSparkline", () => {
    it("builds a 30-day cumulative series with baseline, signs, currency conversion, and ignored types", () => {
        const transactions = [
            transaction(1, "buy", "2026-07-01", 100),
            transaction(2, "buy", "2026-08-01", 20),
            transaction(3, "sell", "2026-08-02", 5),
            transaction(4, "gift", "2026-08-03", 4),
            transaction(5, "dividend", "2026-08-04", 999),
            transaction(6, "buy", "2026-09-01", 999),
        ];
        const now = new Date("2026-08-26T12:00:00");
        const originalNow = now.getTime();
        const convertToTarget = vi.fn((amount: number, currency?: string) =>
            currency === "USD" ? amount * 2 : amount,
        );

        const result = buildNetContributionSparkline({
            transactions,
            summaries: [{ id: 1, currency: "USD" }],
            targetCurrency: "EUR",
            convertToTarget,
            now,
        });

        expect(result).toHaveLength(30);
        expect(result[0].v).toBe(200);
        expect(result[4].v).toBe(240);
        expect(result[5].v).toBe(230);
        expect(result[6].v).toBe(238);
        expect(result.at(-1)?.v).toBe(238);
        expect(now.getTime()).toBe(originalNow);
        expect(transactions[0].amount).toBe(100);
    });

    it("uses the target currency when no investment summary exists", () => {
        const convertToTarget = vi.fn((amount: number) => amount);
        buildNetContributionSparkline({
            transactions: [
                transaction(1, "buy", "2026-08-01", 10, 99),
                transaction(2, "sell", "2026-08-02", 1, 99),
            ],
            summaries: [],
            targetCurrency: "EUR",
            convertToTarget,
            now: new Date("2026-08-26T12:00:00"),
        });

        expect(convertToTarget).toHaveBeenCalledWith(10, "EUR");
        expect(convertToTarget).toHaveBeenCalledWith(-1, "EUR");
    });

    it("hides empty and flat series", () => {
        const options = {
            summaries: [{ id: 1, currency: "EUR" }],
            targetCurrency: "EUR",
            convertToTarget: (amount: number) => amount,
            now: new Date("2026-08-26T12:00:00"),
        };

        expect(buildNetContributionSparkline({ ...options, transactions: [] })).toEqual([]);
        expect(buildNetContributionSparkline({
            ...options,
            transactions: [transaction(1, "buy", "2026-07-01", 100)],
        })).toEqual([]);
    });
});
