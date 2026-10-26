/**
 * Cross-workspace API (ADR-098) — cash-aware rebalancing composing Budgeting
 * + Portfolio data. (The unified-tax surface was removed in ADR-102.)
 */
import { z } from "zod";
import {
    CommitmentAwareCashResponseSchema,
    RebalanceResponseSchema,
} from "@vision/types/contracts";
import { apiRequest } from "@/lib/api/client";
import type { operations } from "@/types/generated";
import type { AccountId, CurrencyCode } from "@vision/types/brands";

export type ModelPortfolio = NonNullable<
    operations["computeRebalance"]["requestBody"]["content"]["application/json"]["model"]
>;

/**
 * A user-defined custom rebalancing target, persisted under the `rebalance_plans`
 * setting. `targetWeights` are keyed by allocation sleeve (need not sum to 1 — the
 * server normalizes); `cashCap`, when set, limits how much spendable cash to deploy.
 */
export interface RebalancePlan {
    id: string;
    name: string;
    targetWeights: Record<string, number>;
    cashCap?: number | undefined;
}

/** Guard for the persisted `rebalance_plans` rows (user-editable JSON). */
export const RebalancePlanSchema = z.object({
    id: z.string(),
    name: z.string(),
    targetWeights: z.record(z.string(), z.number()),
    cashCap: z.number().optional(),
});

export interface RebalanceRequest {
    /** Display/computation currency. Defaults to EUR server-side. */
    currency?: CurrencyCode;
    /** Convenience preset; ignored when `targetWeights` is provided. */
    model?: ModelPortfolio;
    /** Explicit target weights keyed by asset class (need not sum to 1). */
    targetWeights?: Record<string, number>;
    /** Override the server-computed spendable cash. */
    availableCash?: number;
}

export interface RebalanceResponse {
    currency: CurrencyCode;
    targetWeights: Record<string, number>;
    actualValues: Record<string, number>;
    availableCash: number;
    /**
     * The spendable accounts behind `availableCash`. `balance` is that account's
     * cash CONVERTED into `balanceCurrency` (== the response's `currency`), so it
     * is directly summable into `availableCash`; `accountCurrency` is merely the
     * account's own declared code and must never be used to format `balance`.
     */
    cashAccounts: Array<{
        id: AccountId;
        name: string;
        accountCurrency: CurrencyCode;
        balance: number;
        balanceCurrency: CurrencyCode;
        /** Partitions left out of `balance` for want of a stored rate (ADR-216). */
        unconvertedCurrencies: CurrencyCode[];
    }>;
    /** Cash partitions left out of `availableCash` for want of a stored rate. */
    unconvertedCurrencies: string[];
    /** Per-sleeve cash to deploy (only underweight sleeves appear). */
    deployment: Record<string, number>;
}

export interface CommitmentAwareCashResponse {
    currency: CurrencyCode;
    today: string;
    horizonEnd: string;
    horizonDays: number;
    currentCash: number;
    reserveFloor: number;
    minimumProjectedBalance: number;
    minimumDate: string;
    candidateCashCap: number;
    occurrenceCount: number;
    assumptions: {
        plannedOnly: boolean;
        excludesStatisticalForecast: boolean;
        excludesFutureIncome: boolean;
        excludesUnplannedExpenses: boolean;
        currencyConversionAtRecentRates: boolean;
    };
}

export function computeCommitmentAwareCash(req: {
    currency?: CurrencyCode | undefined;
    reserveFloor: number;
}): Promise<CommitmentAwareCashResponse> {
    return apiRequest("/api/cross-workspace/commitment-aware-cash", {
        method: "POST",
        body: JSON.stringify(req),
        schema: CommitmentAwareCashResponseSchema,
    });
}

export function computeRebalance(
    req: RebalanceRequest,
): Promise<RebalanceResponse> {
    return apiRequest("/api/cross-workspace/rebalance", {
        method: "POST",
        body: JSON.stringify(req),
        schema: RebalanceResponseSchema,
    });
}
