/**
 * Derive the banner mode + props for a viewed historical year. Centralised so the tax
 * overview and portfolio-tax pages stay in sync on priority order:
 *
 *   filed > frozen > snapshot > estimate
 *
 * (filed implies frozen; frozen implies a snapshot or estimate baseline.)
 */
import type { HistoricalYearBannerMode } from './HistoricalYearBanner';

interface ResolveBannerInput {
    isFiled: boolean;
    hasFrozenCalculation: boolean;
    hasSnapshot: boolean;
    filingReference?: string;
}

interface ResolveBannerResult {
    mode: HistoricalYearBannerMode;
    filingReference?: string;
}

export function resolveHistoricalBannerMode(input: ResolveBannerInput): ResolveBannerResult {
    if (input.isFiled) {
        return { mode: 'filed', filingReference: input.filingReference };
    }
    if (input.hasFrozenCalculation) {
        return { mode: 'frozen' };
    }
    if (input.hasSnapshot) {
        return { mode: 'snapshot' };
    }
    return { mode: 'estimate' };
}
