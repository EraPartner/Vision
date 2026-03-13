import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';
import logger from '@/lib/logger';

const SETTINGS_KEY = 'portfolio_tax_adjustments_v1';

type AdjustmentEntry = {
  taxes: number;
  fees: number;
};

export type PortfolioTaxAdjustmentMap = Record<string, AdjustmentEntry>;

function keyFor(taxYear: number, investmentId: number): string {
  return `${taxYear}:${investmentId}`;
}

export function usePortfolioTaxAdjustments() {
  const { value: preloaded, isLoading } = usePreloadedSetting<PortfolioTaxAdjustmentMap>(SETTINGS_KEY);
  const [adjustments, setAdjustments] = useState<PortfolioTaxAdjustmentMap>({});

  useEffect(() => {
    if (isLoading) return;
    setAdjustments(preloaded ?? {});
  }, [preloaded, isLoading]);

  const getAdjustment = useCallback(
    (taxYear: number, investmentId: number): AdjustmentEntry => {
      const existing = adjustments[keyFor(taxYear, investmentId)];
      return {
        taxes: Number(existing?.taxes) || 0,
        fees: Number(existing?.fees) || 0,
      };
    },
    [adjustments],
  );

  const setAdjustment = useCallback((taxYear: number, investmentId: number, entry: AdjustmentEntry) => {
    setAdjustments((prev) => ({
      ...prev,
      [keyFor(taxYear, investmentId)]: {
        taxes: Number(entry.taxes) || 0,
        fees: Number(entry.fees) || 0,
      },
    }));
  }, []);

  const mergeForYear = useCallback((base: PortfolioTaxAdjustmentMap, taxYear: number, values: Record<number, AdjustmentEntry>) => {
    const next = { ...base };
    Object.entries(values).forEach(([investmentId, value]) => {
      next[keyFor(taxYear, Number(investmentId))] = {
        taxes: Number(value.taxes) || 0,
        fees: Number(value.fees) || 0,
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
          taxes: Number(value?.taxes) || 0,
          fees: Number(value?.fees) || 0,
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
