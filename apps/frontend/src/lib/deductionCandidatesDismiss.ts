/**
 * Client-side dismissal store for the transaction-derived deduction candidates
 * card on the Tax Overview page.
 *
 * Dismissals are a per-browser preference, so they live in localStorage (same
 * approach as insightsDismiss / RecurringDetectionPanel). A dismissal is keyed
 * by {year, deductionType}: dismissing "unionDues" for 2025 keeps that group
 * hidden across reloads, but the same group still surfaces for other years.
 *
 * All storage access is fault-tolerant: absent (SSR/node), disabled, or
 * malformed localStorage degrades to an empty dismiss list.
 */

export const DISMISSED_DEDUCTION_CANDIDATES_STORAGE_KEY = 'dismissed_deduction_candidates_v1';

export interface DeductionCandidateDismissal {
    year: number;
    deductionType: string;
}

function getStorage(): Storage | null {
    try {
        // globalThis: works in the browser and degrades to null in node-env tests.
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

function isDismissal(value: unknown): value is DeductionCandidateDismissal {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.year === 'number' && typeof v.deductionType === 'string';
}

/** Read the dismiss list from localStorage; malformed/absent storage → empty list. */
export function loadDismissedCandidates(): DeductionCandidateDismissal[] {
    try {
        const raw = getStorage()?.getItem(DISMISSED_DEDUCTION_CANDIDATES_STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isDismissal);
    } catch {
        // Malformed JSON or storage access denied — treat as nothing dismissed.
        return [];
    }
}

/**
 * Dismiss one candidate group for one year. Returns the updated list (also the
 * new state to render from — localStorage alone is not reactive).
 */
export function dismissCandidate(year: number, deductionType: string): DeductionCandidateDismissal[] {
    const state = loadDismissedCandidates();
    const next = isCandidateDismissed(state, year, deductionType)
        ? state
        : [...state, { year, deductionType }];
    try {
        getStorage()?.setItem(DISMISSED_DEDUCTION_CANDIDATES_STORAGE_KEY, JSON.stringify(next));
    } catch {
        // Storage full/denied — dismissal still applies for this session via state.
    }
    return next;
}

export function isCandidateDismissed(
    state: DeductionCandidateDismissal[],
    year: number,
    deductionType: string,
): boolean {
    return state.some((d) => d.year === year && d.deductionType === deductionType);
}
