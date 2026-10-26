import { z } from 'zod';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';
import logger from '@/lib/logger';
import { asInvestmentId } from "@vision/types/brands";
import type { InvestmentId } from "@vision/types/brands";

const SETTINGS_KEY = 'portfolio_tax_adjustments_v1';

type AdjustmentEntry = {
  taxes: number;
  fees: number;
};

export type PortfolioTaxAdjustmentMap = Record<string, AdjustmentEntry>;

/** Persisted settings may hold strings or garbage; anything non-numeric counts as 0. */
function toAmount(value: unknown): number {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

const amountSchema = z.unknown().transform(toAmount);
/** A garbage entry reads as zeros, like `toAmount` on each missing field. */
const adjustmentMapSchema = z.record(
  z.string(),
  z.object({ taxes: amountSchema, fees: amountSchema }).catch({ taxes: 0, fees: 0 }),
);

function keyFor(taxYear: number, investmentId: InvestmentId): string {
  return `${taxYear}:${investmentId}`;
}

export function usePortfolioTaxAdjustments() {
  const { value: preloadedValue, isLoading } = usePreloadedSetting(SETTINGS_KEY);
  const preloaded = useMemo(() => {
    const parsed = adjustmentMapSchema.safeParse(preloadedValue);
    return parsed.success ? parsed.data : null;
  }, [preloadedValue]);
  const [adjustments, setAdjustments] = useState<PortfolioTaxAdjustmentMap>({});

  useEffect(() => {
    if (isLoading) return;
    setAdjustments(preloaded ?? {});
  }, [preloaded, isLoading]);

  const getAdjustment = useCallback(
    (taxYear: number, investmentId: InvestmentId): AdjustmentEntry => {
      const existing = adjustments[keyFor(taxYear, investmentId)];
      return {
        taxes: toAmount(existing?.taxes),
        fees: toAmount(existing?.fees),
      };
    },
    [adjustments],
  );

  const setAdjustment = useCallback((taxYear: number, investmentId: InvestmentId, entry: AdjustmentEntry) => {
    setAdjustments((prev) => ({
      ...prev,
      [keyFor(taxYear, investmentId)]: {
        taxes: toAmount(entry.taxes),
        fees: toAmount(entry.fees),
      },
    }));
  }, []);

  const mergeForYear = useCallback((base: PortfolioTaxAdjustmentMap, taxYear: number, values: Record<number, AdjustmentEntry>) => {
    const next = { ...base };
    Object.entries(values).forEach(([investmentId, value]) => {
      next[keyFor(taxYear, asInvestmentId(Number(investmentId)))] = {
        taxes: toAmount(value.taxes),
        fees: toAmount(value.fees),
      };
    });
    return next;
  }, []);

  const setManyForYear = useCallback((taxYear: number, values: Record<number, AdjustmentEntry>) => {
    setAdjustments((prev) => mergeForYear(prev, taxYear, values));
  }, [mergeForYear]);

  const saveAdjustments = useCallback(async (next?: PortfolioTaxAdjustmentMap) => {
    const toSave = next ?? adjustments;
    try {
      await apiClient.saveSetting(SETTINGS_KEY, toSave);
    } catch (err) {
      logger.error('Failed to save portfolio tax adjustments:', err);
      throw err;
    }
  }, [adjustments]);

  const saveManyForYear = useCallback(async (taxYear: number, values: Record<number, AdjustmentEntry>) => {
    const next = mergeForYear(adjustments, taxYear, values);
    setAdjustments(next);
    await saveAdjustments(next);
  }, [adjustments, mergeForYear, saveAdjustments]);

  const byYear = useMemo(() => {
    return (taxYear: number) => {
      const result: Record<number, AdjustmentEntry> = {};
      Object.entries(adjustments).forEach(([k, value]) => {
        const [yearStr, investmentIdStr] = k.split(':');
        const year = Number(yearStr);
        if (year !== taxYear) return;
        const investmentId = Number(investmentIdStr);
        if (!Number.isFinite(investmentId)) return;
        result[investmentId] = {
          taxes: toAmount(value.taxes),
          fees: toAmount(value.fees),
        };
      });
      return result;
    };
  }, [adjustments]);

  return {
    isLoading,
    adjustments,
    getAdjustment,
    setAdjustment,
    setManyForYear,
    saveManyForYear,
    saveAdjustments,
    byYear,
  };
}
