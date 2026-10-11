import { z } from "zod";

import { WireDateSchema } from "./common.ts";

const NumberRecordSchema = z.record(z.string(), z.number());

/** `POST /api/cross-workspace/rebalance` (routes/crossWorkspace.ts). */
export const RebalanceResponseSchema = z.looseObject({
  currency: z.string(),
  targetWeights: NumberRecordSchema,
  actualValues: NumberRecordSchema,
  availableCash: z.number(),
  cashAccounts: z.array(
    z.looseObject({
      id: z.number().int().positive(),
      name: z.string(),
      accountCurrency: z.string(),
      balance: z.number(),
      balanceCurrency: z.string(),
    }),
  ),
  deployment: NumberRecordSchema,
});

/** `computeCommitmentAwareCash` (services/commitmentAwareCashService.ts). */
export const CommitmentAwareCashResponseSchema = z.looseObject({
  currency: z.string(),
  today: WireDateSchema,
  horizonEnd: WireDateSchema,
  horizonDays: z.number().int().positive(),
  currentCash: z.number(),
  reserveFloor: z.number(),
  minimumProjectedBalance: z.number(),
  minimumDate: WireDateSchema,
  candidateCashCap: z.number(),
  occurrenceCount: z.number().int().nonnegative(),
  assumptions: z.looseObject({
    plannedOnly: z.boolean(),
    excludesStatisticalForecast: z.boolean(),
    excludesFutureIncome: z.boolean(),
    excludesUnplannedExpenses: z.boolean(),
    currencyConversionAtRecentRates: z.boolean(),
  }),
});
