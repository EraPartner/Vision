import { parseYmd } from "@/lib/timezone";
import type { PortfolioTransaction } from "@/types/api";
import type { InvestmentSummary } from "@/types/portfolio";

const DAYS = 30;
const DAY_MS = 86_400_000;

export interface NetContributionPoint {
    t: number;
    v: number;
}

export interface BuildNetContributionSparklineOptions {
    transactions: readonly PortfolioTransaction[];
    summaries: readonly Pick<InvestmentSummary, "id" | "currency">[];
    targetCurrency: string;
    convertToTarget: (amount: number, fromCurrency?: string) => number;
    now?: Date;
}

export function buildNetContributionSparkline({
    transactions,
    summaries,
    targetCurrency,
    convertToTarget,
    now = new Date(),
}: BuildNetContributionSparklineOptions): NetContributionPoint[] {
    if (transactions.length === 0) return [];

    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const startMs = today.getTime() - (DAYS - 1) * DAY_MS;
    const investmentCurrency = new Map<number, string>();
    summaries.forEach((summary) => investmentCurrency.set(summary.id, summary.currency));

    const dailyDelta = new Map<number, number>();
    let baseline = 0;
    for (const transaction of transactions) {
        if (transaction.type !== "buy" && transaction.type !== "sell" && transaction.type !== "gift") continue;
        const amount = Number(transaction.amount) || 0;
        const signed = transaction.type === "sell" ? -amount : amount;
        const currency = investmentCurrency.get(transaction.investment_id) || targetCurrency;
        const inTarget = convertToTarget(signed, currency);
        const transactionDate = parseYmd(transaction.date);
        transactionDate.setHours(0, 0, 0, 0);
        const timestamp = transactionDate.getTime();
        if (timestamp < startMs) {
            baseline += inTarget;
        } else if (timestamp <= today.getTime()) {
            const dayIndex = Math.floor((timestamp - startMs) / DAY_MS);
            dailyDelta.set(dayIndex, (dailyDelta.get(dayIndex) || 0) + inTarget);
        }
    }

    const points: NetContributionPoint[] = [];
    let running = baseline;
    for (let index = 0; index < DAYS; index++) {
        running += dailyDelta.get(index) || 0;
        points.push({ t: startMs + index * DAY_MS, v: running });
    }

    return points.every((point) => point.v === points[0].v) ? [] : points;
}
