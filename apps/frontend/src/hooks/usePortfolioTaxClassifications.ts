import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';
import logger from '@/lib/logger';
import { asInvestmentId } from "@vision/types/brands";
import type { InvestmentId } from "@vision/types/brands";

const SETTINGS_KEY = 'portfolio_tax_classifications_v1';

export type EtfStructure = 'accumulating' | 'distributing';

export interface TaxClassificationEntry {
    etfStructure?: EtfStructure | undefined;
    /**
     * Whether realised gains on this investment are subject to Reynders tax (30%
     * on the bond-attributable portion). `true` → bond / mixed-bond fund.
     * `false` → direct sovereign / corporate bond (gains exempt pre-2026; subject
     * to the 10% CGT from IY 2026 onwards). `undefined` → fall back to
     * assetClass-based default.
     */
    subjectToReynders?: boolean | undefined;
    /**
     * Share of the realised gain attributable to interest, taxed at 30% under
     * Reynders. Range [0, 1]; default 1.0. Remainder (1 - share) flows to the
     * 10% CGT pool from IY 2026 onwards. Only meaningful when
     * `subjectToReynders` is true (or auto-resolves to true).
     */
    reyndersInterestPortion?: number | undefined;
}

export type PortfolioTaxClassificationMap = Record<string, TaxClassificationEntry>;

function keyFor(investmentId: InvestmentId): string {
    return String(investmentId);
}

export function usePortfolioTaxClassifications() {
    const { value: preloadedValue, isLoading } = usePreloadedSetting(SETTINGS_KEY);
    const preloaded = preloadedValue as PortfolioTaxClassificationMap | null;
    const [classifications, setClassifications] = useState<PortfolioTaxClassificationMap>({});

    useEffect(() => {
        if (isLoading) return;
        setClassifications(preloaded ?? {});
    }, [preloaded, isLoading]);

    const getClassification = useCallback(
        (investmentId: InvestmentId): TaxClassificationEntry => {
            return classifications[keyFor(investmentId)] ?? {};
        },
        [classifications],
    );

    const saveClassifications = useCallback(async (next: PortfolioTaxClassificationMap) => {
        try {
            await apiClient.saveSetting(SETTINGS_KEY, next);
        } catch (err) {
            logger.error('Failed to save portfolio tax classifications:', err);
            throw err;
        }
    }, []);

    const setMany = useCallback(async (values: Record<number, TaxClassificationEntry>) => {
        const next: PortfolioTaxClassificationMap = { ...classifications };
        Object.entries(values).forEach(([investmentId, entry]) => {
            const key = keyFor(asInvestmentId(Number(investmentId)));
            // Strip empty entries to keep storage tidy.
            const stripped: TaxClassificationEntry = {};
            if (entry.etfStructure) stripped.etfStructure = entry.etfStructure;
            if (entry.subjectToReynders !== undefined) stripped.subjectToReynders = entry.subjectToReynders;
            if (
                entry.reyndersInterestPortion !== undefined
                && entry.reyndersInterestPortion >= 0
                && entry.reyndersInterestPortion <= 1
                && entry.reyndersInterestPortion !== 1
            ) {
                stripped.reyndersInterestPortion = entry.reyndersInterestPortion;
            }
            if (Object.keys(stripped).length === 0) {
                Reflect.deleteProperty(next, key);
            } else {
                next[key] = stripped;
            }
        });
        setClassifications(next);
        await saveClassifications(next);
    }, [classifications, saveClassifications]);

    const map = useMemo(() => classifications, [classifications]);

    return {
        isLoading,
        classifications: map,
        getClassification,
        setMany,
    };
}
