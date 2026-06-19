/**
 * Cross-workspace API (ADR-098) — cash-aware rebalancing and the unified tax
 * view, both composing Budgeting + Portfolio data.
 */
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';

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
    cashAccounts: Array<{ id: number; name: string; currency: string; balance: number }>;
    /** Per-sleeve cash to deploy (only underweight sleeves appear). */
    deployment: Record<string, number>;
}

export interface UnifiedTaxRequest {
    year: number;
    currency?: string;
    /** Authoritative earned income (the frontend holds the tax-profile gross). */
    earnedIncome?: number;
    earnedIncomeOwner?: 'me' | 'partner' | 'joint';
}

export interface UnifiedTaxResponse {
    year: number;
    currency: string;
    total: number;
    byOwner: { me: number; partner: number };
    byKind: Record<string, number>;
    items: Array<{ amount: number; owner: string; kind: string }>;
}

export function computeRebalance(req: RebalanceRequest): Promise<RebalanceResponse> {
    return apiRequest('/api/cross-workspace/rebalance', {
        method: 'POST',
        body: JSON.stringify(req),
    });
}

export function getUnifiedTax(req: UnifiedTaxRequest): Promise<UnifiedTaxResponse> {
    return requestWithQuery('/api/cross-workspace/unified-tax', {
        year: req.year,
        currency: req.currency,
        earnedIncome: req.earnedIncome,
        earnedIncomeOwner: req.earnedIncomeOwner,
    });
}
