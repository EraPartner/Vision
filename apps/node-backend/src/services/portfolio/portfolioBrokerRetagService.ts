import { withTransaction } from "../../database/connection.ts";
import { validatePortfolioAssetTransferHistory } from "./portfolioAssetTransferService.ts";
import repository from "../../repositories/portfolioBrokerRetagRepository.ts";
import type {
  RetagCustodyEventRow,
  RetagTransactionEventRow,
} from "../../repositories/portfolioBrokerRetagRepository.ts";
import {
  buildInvestmentSummaryCorePartitioned,
  partitionOversellDeficits,
} from "@vision/shared-utils/portfolio";
import type { CostBasisMethod } from "@vision/shared-utils/portfolio";
import { asPartitionedTxns } from "./portfolioTransactionRules.ts";
import { settingsRepository } from "../../repositories/settingsRepository.ts";
import { todayAppDateString } from "../../lib/timezone.ts";
import {
  ConflictError,
  ValidationError,
} from "../../middleware/errorHandler.ts";
import type {
  AccountId,
  InvestmentId,
  PortfolioTransactionId,
} from "@vision/types/brands";

const EPSILON = 1e-8;
const COST_BASIS_METHODS = new Set(["weighted_avg", "fifo", "lifo"]);

/** One investment-history row the re-tag guards replay. */
type RetagHistoryRow = RetagTransactionEventRow | RetagCustodyEventRow;

const CUSTODY_EVENT_TYPES = new Set(["asset_transfer", "asset_adjustment"]);

function isTransactionEvent(
  row: RetagHistoryRow,
): row is RetagTransactionEventRow {
  return !CUSTODY_EVENT_TYPES.has(row.type);
}

/**
 * Whether a history row is a selected portfolio transaction. Custody events
 * carry ids from their own tables, so a matching number is not a selection.
 */
function isSelected(
  row: RetagHistoryRow,
  selectedIds: Set<PortfolioTransactionId>,
): boolean {
  return isTransactionEvent(row) && selectedIds.has(row.id);
}

/** A stored historical FX rate ('YYYY-MM-DD' day, NUMERIC as pg text). */
type HistoricalRateRow = {
  currency_code: string;
  rate_date: string;
  rate_to_eur: string | number;
};

type RateIndex = Map<string, { date: string; rate: number }[]>;

/**
 * A broker re-tag request (validated by the route). The client's
 * idempotency_key is echoed in the receipt but not stored: a repeated request
 * is recognised from the current assignments instead.
 */
export interface RetagRequest {
  transaction_ids: PortfolioTransactionId[];
  from_account_id: AccountId | null;
  to_account_id: AccountId | null;
  idempotency_key: string;
}

function buildRateIndex(rows: readonly HistoricalRateRow[]): RateIndex {
  const index: RateIndex = new Map();
  for (const row of rows) {
    const currency = String(row.currency_code).toUpperCase();
    const entries = index.get(currency) ?? [];
    entries.push({ date: row.rate_date, rate: Number(row.rate_to_eur) });
    index.set(currency, entries);
  }
  return index;
}

function rateOnOrBefore(
  index: RateIndex,
  currency: string,
  date: string,
): number | undefined {
  if (currency === "EUR") return 1;
  const entries = index.get(currency) ?? [];
  let match: number | undefined;
  for (const entry of entries) {
    if (entry.date > date) break;
    if (Number.isFinite(entry.rate) && entry.rate > 0) match = entry.rate;
  }
  return match ?? entries.at(-1)?.rate;
}

/**
 * Verify the complete projected partition history before applying any row.
 * Existing deficits are tolerated, but a re-tag may not create or worsen one.
 */
function assertRetagPreservesPartitionUnits(
  rows: readonly RetagHistoryRow[],
  selectedIds: Set<PortfolioTransactionId>,
  toAccountId: AccountId | null,
): void {
  const byInvestment = new Map<InvestmentId, RetagHistoryRow[]>();
  for (const row of rows) {
    const group = byInvestment.get(row.investment_id) ?? [];
    group.push(row);
    byInvestment.set(row.investment_id, group);
  }

  for (const [investmentId, beforeRows] of byInvestment) {
    const afterRows = beforeRows.map((row) =>
      isSelected(row, selectedIds)
        ? { ...row, account_id: toAccountId }
        : row,
    );
    const before = partitionOversellDeficits(asPartitionedTxns(beforeRows));
    validatePortfolioAssetTransferHistory(afterRows);
    const after = partitionOversellDeficits(asPartitionedTxns(afterRows));
    for (const [accountId, deficit] of after) {
      if (deficit - (before.get(accountId) ?? 0) > EPSILON) {
        throw new ValidationError(
          `re-tag would create or worsen an oversold partition for investment ${investmentId} at account ${accountId}`,
        );
      }
    }
  }
}

/**
 * A broker assignment is part of the production cost-basis model. Combining
 * two histories can change which lots FIFO or LIFO sells consume, so compare
 * the exact partitioned engine before allowing the assignment change.
 */
function assertRetagPreservesPortfolioEconomics(
  rows: readonly RetagHistoryRow[],
  selectedIds: Set<PortfolioTransactionId>,
  toAccountId: AccountId | null,
  costBasisMethod: CostBasisMethod,
  todayYmd: string,
  historicalRates: readonly HistoricalRateRow[] = [],
): void {
  const rateIndex = buildRateIndex(historicalRates);
  const targets = new Set(["EUR", ...rateIndex.keys()]);
  const byInvestment = new Map<InvestmentId, RetagHistoryRow[]>();
  for (const row of rows) {
    const group = byInvestment.get(row.investment_id) ?? [];
    group.push(row);
    byInvestment.set(row.investment_id, group);
  }

  for (const [investmentId, beforeRows] of byInvestment) {
    const afterRows = beforeRows.map((row) =>
      isSelected(row, selectedIds)
        ? { ...row, account_id: toAccountId }
        : row,
    );
    const investment = {
      asset_class: beforeRows[0]?.asset_class ?? "stock",
      current_price: beforeRows[0]?.current_price ?? 0,
      interest_rate: beforeRows[0]?.interest_rate ?? 0,
    };
    const options = { costBasisMethod, todayYmd };
    const before = buildInvestmentSummaryCorePartitioned(
      investment,
      asPartitionedTxns(beforeRows),
      options,
    ).core;
    const after = buildInvestmentSummaryCorePartitioned(
      investment,
      asPartitionedTxns(afterRows),
      options,
    ).core;
    for (const field of [
      "totalUnits",
      "totalInvested",
      "realizedGain",
    ] as const) {
      if (after[field].minus(before[field]).abs().gt(EPSILON)) {
        throw new ValidationError(
          `re-tag would change ${field} for investment ${investmentId} under ${costBasisMethod} cost basis`,
        );
      }
    }
    for (const target of targets) {
      const withTargetFx = (rowsToAnnotate: readonly RetagHistoryRow[]) =>
        rowsToAnnotate.map((row) => {
          const source = String(row.currency ?? "EUR").toUpperCase();
          const stamped = Number(row.fx_rate_to_eur);
          const sourceRate =
            Number.isFinite(stamped) && stamped > 0
              ? stamped
              : source === "EUR"
                ? 1
                : rateOnOrBefore(rateIndex, source, row.date);
          const targetRate = rateOnOrBefore(rateIndex, target, row.date);
          const fxMultiplier =
            source === target
              ? 1
              : target === "EUR" &&
                  Number.isFinite(Number(row.fx_multiplier_eur)) &&
                  Number(row.fx_multiplier_eur) > 0
                ? Number(row.fx_multiplier_eur)
                : Number(sourceRate) / Number(targetRate);
          if (!Number.isFinite(fxMultiplier) || fxMultiplier <= 0) {
            throw new ValidationError(
              `re-tag cannot verify ${target} cost basis for investment ${investmentId}`,
            );
          }
          return { ...row, fxMultiplier };
        });
      const beforeTarget = buildInvestmentSummaryCorePartitioned(
        investment,
        asPartitionedTxns(withTargetFx(beforeRows)),
        options,
      ).core.converted;
      const afterTarget = buildInvestmentSummaryCorePartitioned(
        investment,
        asPartitionedTxns(withTargetFx(afterRows)),
        options,
      ).core.converted;
      for (const field of ["totalInvested", "realizedGain"] as const) {
        if (afterTarget[field].minus(beforeTarget[field]).abs().gt(EPSILON)) {
          throw new ValidationError(
            `re-tag would change ${target} ${field} for investment ${investmentId} under ${costBasisMethod} cost basis`,
          );
        }
      }
    }
  }
}

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
 * The receipt of one call. previous_assignments is each selected row's broker
 * before this call, so a replay reports the destination it already sits on.
 */
function buildReceipt(
  request: RetagRequest,
  transactionIds: PortfolioTransactionId[],
  previousAccountId: AccountId | null,
  changedCount: number,
  replayed: boolean,
) {
  return {
    idempotency_key: request.idempotency_key,
    from_account_id: request.from_account_id,
    to_account_id: request.to_account_id,
    transaction_ids: transactionIds,
    previous_assignments: transactionIds.map((id) => ({
      transaction_id: id,
      account_id: previousAccountId,
    })),
    selected_count: transactionIds.length,
    changed_count: changedCount,
    replayed,
  };
}

async function retagPortfolioTransactions(request: RetagRequest) {
  const transactionIds = [...request.transaction_ids].sort((a, b) => a - b);

  return withTransaction(async () => {
    // Account lifecycle operations lock the account row before touching
    // portfolio transactions. Keep the same order so close-vs-retag cannot
    // deadlock and destination eligibility cannot change before commit.
    if (
      request.to_account_id != null &&
      !(await repository.lockEligibleDestinationAccount(request.to_account_id))
    ) {
      throw new ValidationError(
        "to_account_id must reference an active portfolio account",
      );
    }

    // Retagging needs a stable complete investment history. This table lock is
    // intentionally exceptional: it prevents insert phantoms and serializes
    // portfolio writes for the short set-based operation.
    await repository.lockPortfolioTransactionWrites();

    const selected = await repository.lockTransactions(transactionIds);
    const selectedById = new Map(selected.map((row) => [row.id, row]));
    const isOn = (id: PortfolioTransactionId, accountId: AccountId | null) => {
      const row = selectedById.get(id);
      return row !== undefined && (row.account_id ?? null) === accountId;
    };

    // A repeated request finds every row already on the destination. Under the
    // locks above that state cannot change, so report it without writing.
    if (
      request.from_account_id !== request.to_account_id &&
      transactionIds.every((id) => isOn(id, request.to_account_id))
    ) {
      return buildReceipt(
        request,
        transactionIds,
        request.to_account_id,
        0,
        true,
      );
    }

    const stale = transactionIds.filter(
      (id) => !isOn(id, request.from_account_id),
    );
    if (stale.length > 0) {
      throw new ConflictError(
        "selected portfolio transactions are missing or no longer have the expected broker assignment",
        { details: { stale_transaction_ids: stale } },
      );
    }

    const investmentIds = Array.from(
      new Set(selected.map((row) => row.investment_id)),
    );
    const [histories, historicalRates] = await Promise.all([
      repository.getUnitEventsForInvestments(investmentIds),
      repository.getHistoricalRates(),
    ]);
    assertRetagPreservesPartitionUnits(
      histories,
      new Set(transactionIds),
      request.to_account_id,
    );
    assertRetagPreservesPortfolioEconomics(
      histories,
      new Set(transactionIds),
      request.to_account_id,
      await resolveCostBasisMethod(),
      todayAppDateString(),
      historicalRates,
    );

    const changedIds =
      request.from_account_id === request.to_account_id
        ? []
        : await repository.compareAndSetAccount(
            transactionIds,
            request.from_account_id,
            request.to_account_id,
          );
    if (
      request.from_account_id !== request.to_account_id &&
      changedIds.length !== transactionIds.length
    ) {
      throw new ConflictError(
        "broker assignments changed while the re-tag was being applied",
      );
    }

    return buildReceipt(
      request,
      transactionIds,
      request.from_account_id,
      changedIds.length,
      false,
    );
  });
}

export default { retagPortfolioTransactions };

export {
  assertRetagPreservesPartitionUnits as __assertRetagPreservesPartitionUnits,
  assertRetagPreservesPortfolioEconomics as __assertRetagPreservesPortfolioEconomics,
  retagPortfolioTransactions as __retagPortfolioTransactions,
};
