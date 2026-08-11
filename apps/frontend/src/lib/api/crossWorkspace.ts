/**
 * Cross-workspace API (ADR-098) — cash-aware rebalancing composing Budgeting
 * + Portfolio data. (The unified-tax surface was removed in ADR-102.)
 */
import { apiRequest } from '@/lib/api/client';

export type ModelPortfolio = 'sixty_forty' | 'all_weather' | 'three_fund';

/**
 * A user-defined custom rebalancing target, persisted under the `rebalance_plans`
 * setting. `targetWeights` are keyed by allocation sleeve (need not sum to 1 — the
 * server normalizes); `cashCap`, when set, limits how much spendable cash to deploy.
 */
export interface RebalancePlan {
    id: string;
    name: string;
    targetWeights: Record<string, number>;
    cashCap?: number;
}

export interface RebalanceRequest {
    /** Display/computation currency. Defaults to EUR server-side. */
    currency?: string;
    /** Convenience preset; ignored when `targetWeights` is provided. */
    model?: ModelPortfolio;
    /** Explicit target weights keyed by asset class (need not sum to 1). */
    targetWeights?: Record<string, number>;
    /** Override the server-computed spendable cash. */
    availableCash?: number;
}

export interface RebalanceResponse {
    currency: string;
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
        id: number;
        name: string;
        accountCurrency: string;
        balance: number;
        balanceCurrency: string;
    }>;
    /** Per-sleeve cash to deploy (only underweight sleeves appear). */
    deployment: Record<string, number>;
}

export function computeRebalance(req: RebalanceRequest): Promise<RebalanceResponse> {
    return apiRequest('/api/cross-workspace/rebalance', {
        method: 'POST',
        body: JSON.stringify(req),
    });
}
