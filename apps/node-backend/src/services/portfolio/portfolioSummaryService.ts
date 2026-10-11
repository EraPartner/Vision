/**
 * Portfolio Summary Service
 *
 * Single source of truth for realtime portfolio totals and per-investment
 * summaries. Used by:
 *   - /api/info/portfolio-summary  (dashboard, performance headline cards)
 *   - portfolioPerformanceSnapshotService.getBreakdownSummary (legacy compat)
 *
 * All monetary values in the response are pre-converted to the requested
 * target currency to eliminate frontend FX drift across pages.
 */

import { queryRows } from "../../database/rowContracts.ts";
import {
  archivedIncomeDbRowSchema,
  brokerageCashFeeRowSchema,
  historicalRateRowSchema,
  summaryInvestmentDbRowSchema,
} from "../../database/rows/portfolio.ts";
import type {
  ArchivedIncomeDbRow,
  SummaryInvestmentDbRow,
} from "../../database/rows/portfolio.ts";
import { convertToCurrency } from "../currency/currencyConversionService.ts";
import {
  buildHistoricalRateIndex,
  findRateOnOrBeforeInIndex,
} from "../currency/rateFetcher.ts";
import { buildInvestmentSummaryCorePartitioned } from "@vision/shared-utils/portfolio";
import { asPartitionedTxns } from "./portfolioTransactionRules.ts";
import { settingsRepository } from "../../repositories/settingsRepository.ts";
import { portfolioTransactionRepository } from "../../repositories/portfolioTransactionRepository.ts";
import { todayAppDateString } from "../../lib/timezone.ts";
import { toYmd } from "../../lib/dateFormat.ts";
import {
  toDecimal,
  addAll,
  multiply,
  divide,
  roundMoney,
} from "../../lib/money.ts";
import type {
  HistoricalRateIndex,
  PortfolioMathTxRow,
} from "../../types/rows.ts";

export type DecimalInput = import("@vision/shared-utils/money").DecimalInput;
export type Decimal = import("decimal.js").default;

const round2 = (value: DecimalInput) => roundMoney(value, 2);
const round8 = (value: DecimalInput) => roundMoney(value, 8);

const COST_BASIS_METHODS = new Set(["weighted_avg", "fifo", "lifo"]);

export type CostBasisMethod =
  import("@vision/shared-utils/portfolio").CostBasisMethod;

/**
 * `investments` row from `SELECT i.*, COALESCE(...)` above — same shape as
 * {@link InvestmentRow} except that nothing is coerced here: `current_price`
 * and `interest_rate` are COALESCE-defaulted (never null) pg NUMERIC strings,
 * parsed downstream with `Number()`; the other NUMERIC columns stay strings and
 * `maturity_date` stays a pg local-midnight `Date`.
 */
export type RawInvestmentRow = SummaryInvestmentDbRow;

/** The per-transaction FX annotation `annotateTransactionFxMultipliers` adds. */
type FxAnnotation = {
  fxMultiplier?: number;
  nativeFxMultiplier?: number;
  nativeCurrency?: string;
  _fxFellBack?: boolean;
};

/** The columns `annotateTransactionFxMultipliers` reads, plus its output. */
type FxAnnotatableRow = Pick<
  PortfolioMathTxRow,
  "date" | "fx_rate_to_eur" | "investment_id"
> & {
  currency: string | null;
} & FxAnnotation;

/**
 * A {@link import('../../types/rows.ts').PortfolioMathTxRow} after
 * `annotateTransactionFxMultipliers`: every txn used downstream also carries
 * an `fxMultiplier` (its currency → target multiplier, resolved at its date)
 * and, when neither the stamped nor a historical rate could be resolved,
 * `_fxFellBack: true`.
 */
export type AnnotatedTxRow = PortfolioMathTxRow & FxAnnotation;

/** An archived in-kind income row (`income_recognition_role = 'included_in_units'`). */
type ArchivedIncomeRow = ArchivedIncomeDbRow & FxAnnotation;

export interface PortfolioSummaryOptions {
  /** 'YYYY-MM-DD' — only transactions on or before this day are replayed. */
  throughDate?: string;
  activeInvestmentsOnly?: boolean;
  includeBrokerSnapshotParity?: boolean;
}

/**
 * Resolve the user's configured cost-basis method (Settings → General).
 * Falls back to weighted_avg on missing/invalid values or repository errors —
 * a summary must never fail because a setting row is malformed.
 */
async function resolveCostBasisMethod(): Promise<CostBasisMethod> {
  try {
    const value = await settingsRepository.get("cost_basis_method");
    return typeof value === "string" && COST_BASIS_METHODS.has(value)
      ? (value as CostBasisMethod)
      : "weighted_avg";
  } catch {
    return "weighted_avg";
  }
}

/**
 * Fetch investments and their transactions, then compute per-investment
 * summaries plus aggregated totals — all pre-converted to targetCurrency.
 */
export async function getPortfolioSummary(
  targetCurrency: string = "EUR",
  {
    throughDate = undefined,
    activeInvestmentsOnly = true,
    includeBrokerSnapshotParity = false,
  }: PortfolioSummaryOptions = {},
): Promise<{
  currency: string;
  computed_at: string;
  totals: PortfolioTotals;
  summaries: InvestmentSummary[];
  byAccount: AccountBreakdownRow[];
  archivedInKindIncome: { id: number; totalInKindIncome: number }[];
  brokerageCashFees: Awaited<ReturnType<typeof getBrokerageCashFees>>;
  brokerSnapshotParity?: { totalValue: string; partitionValue: string };
}> {
  const target = (targetCurrency || "EUR").toUpperCase();

  const costBasisMethod = await resolveCostBasisMethod();
  const todayYmd = todayAppDateString();

  const [investmentRows, txnRows]: [RawInvestmentRow[], AnnotatedTxRow[]] =
    await Promise.all([
      queryRows(
        summaryInvestmentDbRowSchema,
        `
      SELECT i.*,
             COALESCE(i.currency, 'EUR') AS currency,
             COALESCE(i.current_price, 0) AS current_price,
             COALESCE(i.interest_rate, 0) AS interest_rate
      FROM investments i
      ${activeInvestmentsOnly ? "WHERE i.is_active = true" : ""}
      ORDER BY i.name
    `,
      ),
      portfolioTransactionRepository.getRowsForPortfolioMath({
        activeInvestmentsOnly,
      }),
    ]);

  const includedTxnRows = throughDate
    ? txnRows.filter((txn) => toYmd(txn.date) <= throughDate)
    : txnRows;

  const txnsByInvestment = new Map<number, AnnotatedTxRow[]>();
  for (const txn of includedTxnRows) {
    const id = Number(txn.investment_id);
    let bucket = txnsByInvestment.get(id);
    if (!bucket) txnsByInvestment.set(id, (bucket = []));
    bucket.push(txn);
  }

  // Resolve the FX multiplier once per *distinct* currency rather than once
  // per investment — buildInvestmentSummary then runs synchronously. Both
  // investment currencies (current-value conversion) and transaction
  // currencies (per-txn fallback) are needed.
  const distinctCurrencies = [
    ...new Set([
      ...investmentRows.map((inv) => (inv.currency || "EUR").toUpperCase()),
      ...includedTxnRows.map((txn) => (txn.currency || "EUR").toUpperCase()),
    ]),
  ];
  const multiplierByCurrency = new Map<string, number>();
  await Promise.all(
    distinctCurrencies.map(async (cur) => {
      multiplierByCurrency.set(
        cur,
        cur === target ? 1 : await convertToCurrency(1, cur, target),
      );
    }),
  );

  // Historical rates for every involved currency (plus the target), so each
  // transaction converts at the rate of ITS date — invested capital must not
  // move when today's rate does (the FX-attribution contract).
  const historicalIndex = await loadHistoricalRateIndex(
    distinctCurrencies,
    target,
  );
  annotateTransactionFxMultipliers(
    includedTxnRows,
    target,
    historicalIndex,
    multiplierByCurrency,
    new Map(
      investmentRows.map((inv) => [
        Number(inv.id),
        (inv.currency || "EUR").toUpperCase(),
      ]),
    ),
  );

  const perInvestment = investmentRows.map((inv) =>
    buildInvestmentSummary(
      inv,
      txnsByInvestment.get(Number(inv.id)) ?? [],
      target,
      multiplierByCurrency,
      {
        costBasisMethod,
        todayYmd,
      },
    ),
  );
  const summaries = perInvestment.map((r) => r.summary);

  const totals = aggregateTotals(summaries);
  const byAccount = aggregateByAccount(
    perInvestment.flatMap((r) => r.accountContributions),
  );

  // Archived descriptive income must use its transaction currency and date.
  // The active holding totals keep their existing scope and replay behavior.
  let archivedInKindIncome: { id: number; totalInKindIncome: number }[];
  if (activeInvestmentsOnly) {
    const archivedRows: ArchivedIncomeRow[] = await queryRows(
      archivedIncomeDbRowSchema,
      `
        SELECT pt.investment_id, pt.amount, pt.currency,
               to_char(pt.date, 'YYYY-MM-DD') AS date, pt.fx_rate_to_eur
        FROM portfolio_transactions pt
        JOIN investments i ON i.id = pt.investment_id
        WHERE i.is_active = false
          AND pt.income_recognition_role = 'included_in_units'
          ${throughDate ? "AND pt.date <= $1::date" : ""}
        ORDER BY pt.investment_id, pt.date, pt.id
      `,
      throughDate ? [throughDate] : [],
    );
    const archiveCurrencies = [
      ...new Set(archivedRows.map((row) => row.currency || "EUR")),
    ];
    const archiveMultipliers = new Map<string, number>();
    for (const currency of archiveCurrencies)
      archiveMultipliers.set(
        currency,
        currency === target ? 1 : await convertToCurrency(1, currency, target),
      );
    annotateTransactionFxMultipliers(
      archivedRows,
      target,
      await loadHistoricalRateIndex(archiveCurrencies, target),
      archiveMultipliers,
    );
    const archiveTotals = new Map<number, Decimal>();
    for (const row of archivedRows) {
      const id = Number(row.investment_id);
      archiveTotals.set(
        id,
        addAll([
          archiveTotals.get(id) ?? 0,
          multiply(row.amount ?? 0, row.fxMultiplier ?? 1),
        ]),
      );
    }
    archivedInKindIncome = [...archiveTotals].map(([id, amount]) => ({
      id,
      totalInKindIncome: round2(amount),
    }));
  } else {
    const archivedIds = new Set(
      investmentRows
        .filter((row) => !row.is_active)
        .map((row) => Number(row.id)),
    );
    archivedInKindIncome = summaries
      .filter((row) => archivedIds.has(Number(row.id)))
      .map((row) => ({
        id: Number(row.id),
        totalInKindIncome: row.totalInKindIncome,
      }));
  }

  const brokerageCashFees = await getBrokerageCashFees(
    target,
    throughDate ?? todayYmd,
    totals.totalGainLoss,
  );

  return {
    currency: target,
    computed_at: new Date().toISOString(),
    totals,
    summaries,
    byAccount,
    archivedInKindIncome,
    brokerageCashFees,
    // Snapshot parity must compare the same unrounded valuation tracks. Public
    // totals sum individually rounded investments; account rows round once.
    ...(includeBrokerSnapshotParity
      ? {
          brokerSnapshotParity: {
            totalValue: addAll(
              perInvestment.map((r) => r.unroundedCurrentValue),
            ).toString(),
            partitionValue: addAll(
              perInvestment.flatMap((r) =>
                r.accountContributions.map((c) => c.currentValue),
              ),
            ).toString(),
          },
        }
      : {}),
  };
}

/**
 * Imported costs with no security allocation stay in the cash ledger. Report
 * only source-owned fees, once per canonical ID, separately from investment
 * returns. Economic ownership survives category and memo edits.
 */
async function getBrokerageCashFees(
  target: string,
  throughDate: string,
  investmentGain: Parameters<typeof toDecimal>[0],
) {
  const rows = await queryRows(
    brokerageCashFeeRowSchema,
    `WITH owned_fee_ids AS (
        SELECT t.id
        FROM transactions t
        WHERE EXISTS (
          SELECT 1
          FROM portfolio_import_staging_rows s
          JOIN portfolio_import_batches b ON b.id = s.batch_id
          WHERE s.committed_txn_id = t.id
            AND s.status = 'committed'
            AND s.route = 'cash'
            AND s.type = 'fee'
            AND b.is_brokerage = true
            AND b.status <> 'aborted'
            AND b.account_id = t.account_id
            AND s.resolved_investment_id IS NULL
            AND s.user_override_investment_id IS NULL
            AND NULLIF(BTRIM(COALESCE(s.symbol_raw, '')), '') IS NULL
            AND NULLIF(BTRIM(COALESCE(s.name_raw, '')), '') IS NULL
            AND COALESCE(s.units, 0) = 0
            AND COALESCE(s.price_per_unit, 0) = 0
            AND COALESCE(s.fees, 0) = 0
            AND COALESCE(s.taxes, 0) = 0
            AND s.tx_date = t.date
            AND s.currency = t.currency
            AND t.amount = -ABS(s.amount)
            AND NULLIF(s.source_record_hash, '') IS NOT NULL
            AND s.source_record_hash = t.source_record_hash
            AND NULLIF(s.dedup_fingerprint, '') IS NOT NULL
            AND s.dedup_fingerprint = t.dedup_fingerprint
            AND s.dedup_fingerprint_version = t.dedup_fingerprint_version
        )
        UNION
        SELECT fee.id
        FROM portfolio_import_staging_rows s
        JOIN portfolio_import_batches b ON b.id = s.batch_id
        CROSS JOIN LATERAL (SELECT portfolio_cash_receipt(s.raw_data) AS receipt) r
        JOIN transactions main
          ON main.id = s.committed_txn_id
         AND main.id::text = r.receipt->'after'->>'id'
        JOIN transactions fee
          ON fee.id::text = r.receipt->'feeAfter'->>'id'
        WHERE s.status = 'committed'
          AND s.route = 'cash'
          AND s.type IS NULL
          AND b.is_brokerage = true
          AND b.status <> 'aborted'
          AND b.custom_config->>'format' = 'kinesis_transaction_history'
          AND r.receipt->>'version' = '1'
          AND r.receipt->'proof'->>'kind' = 'closed_kinesis_cash'
          AND r.receipt->'proof'->>'eventKind' = 'own_account_funding'
          AND r.receipt->'proof'->>'componentCount' = '2'
          AND r.receipt->'feeValues'->>'isTransfer' = 'false'
          AND main.id <> fee.id
          AND main.is_active = true
          AND main.is_transfer = true
          AND main.transfer_source = 'brokerage'
          AND main.account_id = b.account_id
          AND main.source_record_hash = s.source_record_hash
          AND main.dedup_fingerprint = s.dedup_fingerprint
          AND main.dedup_fingerprint_version = s.dedup_fingerprint_version
          AND fee.account_id = b.account_id
          AND fee.account_id::text = r.receipt->'feeAfter'->>'account_id'
          AND to_char(fee.date, 'YYYY-MM-DD') = r.receipt->'feeAfter'->>'date'
          AND fee.currency = r.receipt->'feeAfter'->>'currency'
          AND fee.amount::text = r.receipt->'feeAfter'->>'amount'
          AND fee.source_record_hash = s.source_record_hash
          AND fee.source_record_hash = r.receipt->'feeAfter'->>'source_record_hash'
          AND fee.dedup_fingerprint = r.receipt->'feeAfter'->>'dedup_fingerprint'
          AND fee.dedup_fingerprint_version::text = r.receipt->'feeAfter'->>'dedup_fingerprint_version'
          AND fee.transfer_source = 'brokerage'
      )
      SELECT t.id, t.account_id, to_char(t.date, 'YYYY-MM-DD') AS date,
             t.currency, (-t.amount)::text AS amount
      FROM transactions t
      JOIN owned_fee_ids owned ON owned.id = t.id
      WHERE t.is_active = true
        AND t.amount < 0
        AND t.is_transfer = false
        AND t.balance IS NULL
        AND COALESCE(t.transfer_source, '') IN ('', 'brokerage')
        AND t.date <= $1::date
        AND NOT EXISTS (
          SELECT 1 FROM portfolio_transactions pt
          WHERE pt.source_record_hash = t.source_record_hash
            AND (COALESCE(pt.fees, 0) <> 0 OR pt.type = 'fee')
        )
      ORDER BY t.date, t.id`,
    [throughDate],
  );
  const currencies = [...new Set(rows.map((row) => row.currency))];
  const historicalIndex = await loadHistoricalRateIndex(currencies, target);
  const fallbackMultipliers = new Map<string, number>();
  let usedFallbackRate = false;
  const accounts = new Map<number, Decimal>();
  for (const row of rows) {
    let multiplier = 1;
    if (row.currency !== target) {
      const from = findRateOnOrBeforeInIndex(
        historicalIndex,
        row.currency,
        row.date,
      );
      const to = findRateOnOrBeforeInIndex(historicalIndex, target, row.date);
      if (from !== undefined && to !== undefined && to > 0) {
        multiplier = from / to;
      } else {
        usedFallbackRate = true;
        if (!fallbackMultipliers.has(row.currency)) {
          fallbackMultipliers.set(
            row.currency,
            await convertToCurrency(1, row.currency, target),
          );
        }
        multiplier = fallbackMultipliers.get(row.currency)!;
      }
    }
    const account = Number(row.account_id);
    accounts.set(
      account,
      addAll([accounts.get(account) ?? 0, multiply(row.amount, multiplier)]),
    );
  }
  const total = round2(addAll([...accounts.values()]));
  return {
    total,
    gainAfterFees: round2(toDecimal(investmentGain).minus(total)),
    usedFallbackRate,
    byAccount: [...accounts].map(([account_id, amount]) => ({
      account_id,
      total: round2(amount),
    })),
  };
}

/**
 * One investment's contribution to a single byAccount row, in target currency
 * (unrounded Decimals — rounding happens once per account row on emit).
 */
export type AccountContribution = {
  account_id: number | null;
  assignment: "account" | "unassigned";
  contribution_kind: "position" | "non_position";
  oversold: boolean;
  currentValue: Decimal;
  totalInvested: Decimal;
  realizedGain: Decimal;
  unrealizedGain: Decimal;
  gainLoss: Decimal;
};

/** One emitted byAccount row: an {@link AccountContribution} rounded once. */
export type AccountBreakdownRow = Omit<
  AccountContribution,
  | "currentValue"
  | "totalInvested"
  | "realizedGain"
  | "unrealizedGain"
  | "gainLoss"
> & {
  currentValue: number;
  totalInvested: number;
  realizedGain: number;
  unrealizedGain: number;
  gainLoss: number;
};

/**
 * Per-account holdings + P&L breakdown (ADR-108): sum the per-(investment,
 * account) partition contributions produced by the partitioned engine. Σ of
 * the rows ≡ the portfolio totals BY CONSTRUCTION — for a fully-assigned
 * instrument its investment core is the exact sum of its partition cores; for
 * anything else the whole (flat-engine) core contributes to the unassigned
 * (account_id null) row, per the ADR-108 transition rule: NEVER wrong
 * partitions. `totalInvested` follows the totals' definition (gross buy cost,
 * see aggregateTotals note). Names are resolved by the caller — ids only.
 */
function aggregateByAccount(
  contributions: AccountContribution[],
): AccountBreakdownRow[] {
  const acc = new Map<string, AccountContribution>(); // (account_id, contribution kind) → aggregate
  for (const c of contributions) {
    const key = `${c.account_id ?? "null"}:${c.contribution_kind}`;
    const cur: AccountContribution = acc.get(key) ?? {
      account_id: c.account_id,
      assignment: c.account_id == null ? "unassigned" : "account",
      contribution_kind: c.contribution_kind,
      oversold: false,
      currentValue: toDecimal(0),
      totalInvested: toDecimal(0),
      realizedGain: toDecimal(0),
      unrealizedGain: toDecimal(0),
      gainLoss: toDecimal(0),
    };
    cur.currentValue = cur.currentValue.plus(c.currentValue);
    cur.totalInvested = cur.totalInvested.plus(c.totalInvested);
    cur.realizedGain = cur.realizedGain.plus(c.realizedGain);
    cur.unrealizedGain = cur.unrealizedGain.plus(c.unrealizedGain);
    cur.gainLoss = cur.gainLoss.plus(c.gainLoss);
    cur.oversold ||= c.oversold;
    acc.set(key, cur);
  }
  return [...acc.values()]
    .map((a) => ({
      account_id: a.account_id,
      assignment: a.assignment,
      contribution_kind: a.contribution_kind,
      oversold: a.oversold,
      currentValue: round2(a.currentValue),
      totalInvested: round2(a.totalInvested),
      realizedGain: round2(a.realizedGain),
      unrealizedGain: round2(a.unrealizedGain),
      gainLoss: round2(a.gainLoss),
    }))
    .sort((x, y) => y.currentValue - x.currentValue);
}

/**
 * Load all stored historical rates for the involved currencies into an
 * in-memory index (sorted per currency, binary-searched per lookup).
 */
async function loadHistoricalRateIndex(
  currencies: string[],
  target: string,
): Promise<HistoricalRateIndex> {
  const relevant = [...new Set([...currencies, target])].filter(
    (c) => c && c !== "EUR",
  );
  if (relevant.length === 0) return new Map();
  const rows = await queryRows(
    historicalRateRowSchema,
    `SELECT currency_code, to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate_to_eur
     FROM exchange_rates
     WHERE currency_code = ANY($1::text[])
     ORDER BY currency_code ASC, rate_date ASC`,
    [relevant],
  );
  return buildHistoricalRateIndex(rows);
}

/**
 * Attach `fxMultiplier` (txn currency → target at the txn's date) to each
 * transaction row, preferring the rate stamped on the transaction
 * (fx_rate_to_eur). Rows whose historical rate is unresolvable fall back to
 * today's rate and are flagged so the response can disclose it.
 */
function annotateTransactionFxMultipliers(
  txns: FxAnnotatableRow[],
  target: string,
  historicalIndex: HistoricalRateIndex,
  multiplierByCurrency: Map<string, number>,
  investmentCurrencyById: Map<number, string> = new Map(),
): void {
  for (const txn of txns) {
    const txnCurrency = (txn.currency || "EUR").toUpperCase();
    const nativeCurrency =
      investmentCurrencyById.get(Number(txn.investment_id)) ?? txnCurrency;
    txn.nativeCurrency = nativeCurrency;
    const stampedRate = Number(txn.fx_rate_to_eur);
    const rateFrom =
      txnCurrency === "EUR"
        ? 1
        : Number.isFinite(stampedRate) && stampedRate > 0
          ? stampedRate
          : findRateOnOrBeforeInIndex(historicalIndex, txnCurrency, txn.date);
    if (txnCurrency === nativeCurrency) {
      txn.nativeFxMultiplier = 1;
    } else {
      // Booked amounts stay untouched. Reconstruct quote-currency basis with
      // daily on-or-before FX; this does not isolate broker execution markups.
      const rateNative = findRateOnOrBeforeInIndex(
        historicalIndex,
        nativeCurrency,
        txn.date,
      );
      if (
        rateFrom !== undefined &&
        rateNative !== undefined &&
        rateNative > 0
      ) {
        txn.nativeFxMultiplier = rateFrom / rateNative;
      } else {
        txn.nativeFxMultiplier =
          (multiplierByCurrency.get(txnCurrency) ?? 1) /
          (multiplierByCurrency.get(nativeCurrency) ?? 1);
        txn._fxFellBack = true;
      }
    }
    if (txnCurrency === target) {
      txn.fxMultiplier = 1;
      continue;
    }

    const rateTo =
      target === "EUR"
        ? 1
        : findRateOnOrBeforeInIndex(historicalIndex, target, txn.date);

    if (rateFrom !== undefined && rateTo !== undefined && rateTo > 0) {
      txn.fxMultiplier = rateFrom / rateTo;
    } else {
      txn.fxMultiplier = multiplierByCurrency.get(txnCurrency) ?? 1;
      txn._fxFellBack = true;
    }
  }
}

/**
 * Compute a rich summary for a single investment, with all monetary fields
 * pre-converted to targetCurrency.
 *
 * The math lives in @vision/shared-utils/portfolio (buildInvestmentSummaryCore)
 * and is shared verbatim with the frontend hook — only FX conversion, rounding
 * and response shaping happen here. Flow amounts (invested, buy cost, fees,
 * income, realized gains) convert at their transaction-date rates; holdings
 * values (current value/price, accrued interest) convert at today's rate. The
 * resulting gain therefore includes the FX component, decomposed into
 * assetGain + fxGain (ADR: FX attribution).
 *
 * ADR-108: the core is computed by the PARTITIONED engine — for an investment
 * whose lots are fully broker-assigned it is the exact sum of its per-account
 * partition cores (sells consume same-account lots under the configured
 * method), otherwise the flat global replay, unchanged. The per-partition
 * contributions feed the byAccount breakdown; `fullyAssigned` is emitted on
 * the summary so read surfaces can render "assign lots to see per-broker
 * figures" instead of wrong partitions.
 *
 * @param inv  raw investment row
 * @param txns transaction rows for this investment (fxMultiplier-annotated)
 * @param multiplierByCurrency  FX multiplier per currency
 */
function buildInvestmentSummary(
  inv: RawInvestmentRow,
  txns: AnnotatedTxRow[],
  targetCurrency: string,
  multiplierByCurrency: Map<string, number>,
  opts: { costBasisMethod: CostBasisMethod; todayYmd: string },
) {
  const invCurrency = (inv.currency || "EUR").toUpperCase();
  // Multiplier was resolved once per distinct currency by the caller.
  const multiplier = multiplierByCurrency.get(invCurrency) ?? 1;

  const { core, partitions, fullyAssigned } =
    buildInvestmentSummaryCorePartitioned(inv, asPartitionedTxns(txns), {
      ...opts,
      fxMultiplierNow: multiplier,
    });
  const cv = core.converted;
  const conv = (v: DecimalInput) => multiply(v, multiplier);

  const convertedCurrentValue = cv.currentValue;
  const convertedTotalInvested = cv.totalInvested;
  const convertedTotalBuyCost = cv.totalBuyCost;
  const convertedTotalSellProceeds = cv.totalSellProceeds;
  const convertedTotalFees = cv.totalFees;
  const convertedTotalTaxes = cv.totalTaxes;
  const convertedTotalDividends = cv.totalDividends;
  const convertedTotalIncome = cv.totalIncome;
  const convertedRealizedGain = cv.realizedGain;
  const convertedUnrealizedGain = cv.unrealizedGain;
  const convertedTotalGain = cv.totalGain;
  const convertedGainLoss = cv.gainLoss;
  const convertedAvgCostBasis = cv.avgCostBasis;
  const convertedAccruedInterest = conv(core.accruedInterest);
  const convertedProjectedInterest = conv(core.projectedAnnualInterest);
  const convertedTotalAppreciation = conv(core.totalAppreciation);
  const convertedCurrentPrice = conv(Number(inv.current_price) || 0);
  const { totalUnits } = core;
  const gainLossPercent = cv.gainLossPercent;
  const usedFallbackRate = txns.some((t) => t._fxFellBack === true);

  // Per-account contributions in target currency: value at today's rate,
  // flows locked at their transaction-date rates — the same converted track
  // the summary itself emits, so Σ contributions ≡ the summary's own fields.
  const accountContributions = partitions.map((p): AccountContribution => ({
    account_id: p.accountId,
    assignment: p.accountId == null ? "unassigned" : "account",
    contribution_kind: p.contributionKind,
    oversold: p.core.oversold,
    currentValue: p.core.converted.currentValue,
    totalInvested: p.core.converted.totalBuyCost,
    realizedGain: p.core.converted.realizedGain,
    unrealizedGain: p.core.converted.unrealizedGain,
    gainLoss: p.core.converted.gainLoss,
  }));

  const summary = {
    // Identity passthrough — base investment fields the frontend already uses
    id: Number(inv.id),
    name: inv.name,
    symbol: inv.symbol,
    asset_class: inv.asset_class,
    assetClass: inv.asset_class,
    is_active: inv.is_active,
    created_at: inv.created_at,
    updated_at: inv.updated_at,
    notes: inv.notes,
    location: inv.location,
    municipality: inv.municipality,
    cadastral_income: inv.cadastral_income,
    municipality_tax_rate: inv.municipality_tax_rate,
    maturity_date: inv.maturity_date,
    maturityDate: inv.maturity_date,
    price_provider: inv.price_provider,
    price_provider_id: inv.price_provider_id,
    price_provider_url: inv.price_provider_url,
    price_provider_latest_url: inv.price_provider_latest_url,
    price_provider_latest_path: inv.price_provider_latest_path,
    price_provider_history_url: inv.price_provider_history_url,
    price_provider_history_path: inv.price_provider_history_path,
    price_provider_history_ts_path: inv.price_provider_history_ts_path,
    price_provider_history_price_path: inv.price_provider_history_price_path,
    price_updated_at: inv.price_updated_at,

    // The summary's display currency. All monetary fields below are expressed
    // in this currency. The investment's native currency is preserved as
    // `originalCurrency` so the UI can still display it as a label.
    currency: targetCurrency,
    originalCurrency: invCurrency,

    // Computed numerics — pre-converted to targetCurrency
    totalUnits: round8(totalUnits),
    currentPrice: round2(convertedCurrentPrice),
    current_price: round2(convertedCurrentPrice),
    interestRate: Number(inv.interest_rate) || 0,
    interest_rate: Number(inv.interest_rate) || 0,

    totalInvested: round2(convertedTotalInvested),
    totalBuyCost: round2(convertedTotalBuyCost),
    totalSellProceeds: round2(convertedTotalSellProceeds),
    currentValue: round2(convertedCurrentValue),
    totalFees: round2(convertedTotalFees),
    totalTaxes: round2(convertedTotalTaxes),
    totalDividends: round2(convertedTotalDividends),
    totalIncome: round2(convertedTotalIncome),
    totalInKindIncome: round2(cv.totalInKindIncome),

    avgCostBasis: round2(convertedAvgCostBasis),
    realizedGain: round2(convertedRealizedGain),
    unrealizedGain: round2(convertedUnrealizedGain),
    totalGain: round2(convertedTotalGain),
    gainLoss: round2(convertedGainLoss),
    gainLossPercent: round2(gainLossPercent),

    // FX attribution: gainLoss = assetGain (native performance at today's
    // rate) + fxGain (currency effect). nativeCurrentValue is the holding's
    // value in its own currency, untouched by FX.
    assetGain: round2(cv.assetGain),
    fxGain: round2(cv.fxGain),
    nativeCurrentValue: round2(core.currentValue),
    usedFallbackRate,

    accruedInterest: round2(convertedAccruedInterest),
    projectedAnnualInterest: round2(convertedProjectedInterest),
    totalAppreciation: round2(convertedTotalAppreciation),

    // ADR-108 transition flag: false while the instrument still has broker-
    // unassigned lots (its per-account figures then live entirely on the
    // byAccount null row — read surfaces show an "assign lots" nudge instead).
    fullyAssigned,
    oversold: core.oversold,
    // Exact per-investment broker partitions for client-side filtering. The
    // portfolio-wide `byAccount` array remains the round-once aggregate truth.
    byAccount: aggregateByAccount(accountContributions),
  };

  return {
    summary,
    accountContributions,
    unroundedCurrentValue: convertedCurrentValue,
  };
}

/**
 * Reduce per-investment summaries into portfolio-wide totals.
 * All values are already in the same target currency, so straight summation.
 */
// Note on the "invested" definition (see TODO audit): `totalInvested` here sums
// per-investment `totalBuyCost`, which for unit-based assets is gross cash in
// INCLUDING acquisition fees/taxes (calculateCostBasis folds them in), and for
// fixed-income/real-estate is the buy/gift amount only. The frontend mirror
// matches. Treat this as "gross buy cost (acquisition costs included where the
// asset class records them per-row)"; documented here rather than re-grained to
// avoid changing every reported invested figure.
function aggregateTotals(summaries: InvestmentSummary[]) {
  const acc = {
    totalPortfolioValue: addAll(summaries.map((s) => s.currentValue)),
    totalInvested: addAll(summaries.map((s) => s.totalBuyCost)),
    totalGainLoss: addAll(summaries.map((s) => s.gainLoss)),
    totalRealizedGain: addAll(summaries.map((s) => s.realizedGain)),
    totalUnrealizedGain: addAll(summaries.map((s) => s.unrealizedGain)),
    totalGain: addAll(summaries.map((s) => s.totalGain)),
    totalIncome: addAll(summaries.map((s) => s.totalIncome)),
    totalDividends: addAll(summaries.map((s) => s.totalDividends)),
    totalInKindIncome: addAll(summaries.map((s) => s.totalInKindIncome)),
    totalFees: addAll(summaries.map((s) => s.totalFees)),
    totalTaxes: addAll(summaries.map((s) => s.totalTaxes)),
    totalAssetGain: addAll(summaries.map((s) => s.assetGain)),
    totalFxGain: addAll(summaries.map((s) => s.fxGain)),
  };

  const totalReturnPct = acc.totalInvested.gt(0)
    ? divide(acc.totalGainLoss, acc.totalInvested).times(100)
    : toDecimal(0);

  return {
    totalPortfolioValue: round2(acc.totalPortfolioValue),
    totalInvested: round2(acc.totalInvested),
    totalGainLoss: round2(acc.totalGainLoss),
    totalRealizedGain: round2(acc.totalRealizedGain),
    totalUnrealizedGain: round2(acc.totalUnrealizedGain),
    totalGain: round2(acc.totalGain),
    totalIncome: round2(acc.totalIncome),
    totalDividends: round2(acc.totalDividends),
    totalInKindIncome: round2(acc.totalInKindIncome),
    totalFees: round2(acc.totalFees),
    totalTaxes: round2(acc.totalTaxes),
    totalAssetGain: round2(acc.totalAssetGain),
    totalFxGain: round2(acc.totalFxGain),
    totalReturnPct: round2(totalReturnPct),
    usedFallbackRate: summaries.some((s) => s.usedFallbackRate === true),
  };
}

/** One investment's emitted summary (all money in the target currency). */
export type InvestmentSummary = ReturnType<
  typeof buildInvestmentSummary
>["summary"];

/** The portfolio-wide totals of a {@link getPortfolioSummary} response. */
export type PortfolioTotals = ReturnType<typeof aggregateTotals>;

/** The resolved {@link getPortfolioSummary} response. */
export type PortfolioSummary = Awaited<ReturnType<typeof getPortfolioSummary>>;

/**
 * Backward-compat narrow shape for /portfolio-performance.breakdownSummary.
 * Delegates to the same compute path so values can never diverge.
 */
export async function getBreakdownSummary(targetCurrency: string = "EUR") {
  const { summaries } = await getPortfolioSummary(targetCurrency);
  return summaries.map((s) => ({
    id: s.id,
    name: s.name,
    symbol: s.symbol,
    assetClass: s.asset_class,
    currency: s.originalCurrency,
    currentValue: s.currentValue,
    totalInvested: s.totalInvested,
    gainLoss: s.gainLoss,
    gainLossPercent: s.gainLossPercent,
    assetGain: s.assetGain,
    fxGain: s.fxGain,
    nativeCurrentValue: s.nativeCurrentValue,
    usedFallbackRate: s.usedFallbackRate,
  }));
}
