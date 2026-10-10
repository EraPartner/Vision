import crypto from "node:crypto";
import { withTransaction } from "../../database/connection.ts";
import { validatePortfolioAssetTransferHistory } from "./portfolioAssetTransferService.ts";
import repository from "../../repositories/portfolioBrokerRetagRepository.ts";
import type {
  PortfolioRetagAuditRow,
  RetagCustodyEventRow,
  RetagTransactionEventRow,
} from "../../repositories/portfolioBrokerRetagRepository.ts";
import { appendAuditEvent } from "../../repositories/auditChainRepository.ts";
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

const EPSILON = 1e-8;
const COST_BASIS_METHODS = new Set(["weighted_avg", "fifo", "lifo"]);

/** One investment-history row the re-tag guards replay. */
type RetagHistoryRow = RetagTransactionEventRow | RetagCustodyEventRow;

/** A stored historical FX rate ('YYYY-MM-DD' day, NUMERIC as pg text). */
type HistoricalRateRow = {
  currency_code: string;
  rate_date: string;
  rate_to_eur: string | number;
};

type RateIndex = Map<string, { date: string; rate: number }[]>;

/** A broker re-tag request (validated by the route). */
export interface RetagRequest {
  transaction_ids: number[];
  from_account_id: number | null;
  to_account_id: number | null;
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

function fingerprintRetagRequest(
  value: Pick<
    RetagRequest,
    "transaction_ids" | "from_account_id" | "to_account_id"
  >,
): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        transaction_ids: [...value.transaction_ids].sort((a, b) => a - b),
        from_account_id: value.from_account_id,
        to_account_id: value.to_account_id,
      }),
    )
    .digest("hex");
}

/**
 * Verify the complete projected partition history before applying any row.
 * Existing deficits are tolerated, but a re-tag may not create or worsen one.
 */
function assertRetagPreservesPartitionUnits(
  rows: readonly RetagHistoryRow[],
  selectedIds: Set<number>,
  toAccountId: number | null,
): void {
  const byInvestment = new Map<number, RetagHistoryRow[]>();
  for (const row of rows) {
    const investmentId = Number(row.investment_id);
    const group = byInvestment.get(investmentId) ?? [];
    group.push(row);
    byInvestment.set(investmentId, group);
  }

  for (const [investmentId, beforeRows] of byInvestment) {
    const afterRows = beforeRows.map((row) =>
      selectedIds.has(Number(row.id))
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
  selectedIds: Set<number>,
  toAccountId: number | null,
  costBasisMethod: CostBasisMethod,
  todayYmd: string,
  historicalRates: readonly HistoricalRateRow[] = [],
): void {
  const rateIndex = buildRateIndex(historicalRates);
  const targets = new Set(["EUR", ...rateIndex.keys()]);
  const byInvestment = new Map<number, RetagHistoryRow[]>();
  for (const row of rows) {
    const investmentId = Number(row.investment_id);
    const group = byInvestment.get(investmentId) ?? [];
    group.push(row);
    byInvestment.set(investmentId, group);
  }

  for (const [investmentId, beforeRows] of byInvestment) {
    const afterRows = beforeRows.map((row) =>
      selectedIds.has(Number(row.id))
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

function mapReceipt(row: PortfolioRetagAuditRow, replayed: boolean) {
  return {
    receipt_id: Number(row.id),
    idempotency_key: row.idempotency_key,
    from_account_id: row.from_account_id,
    to_account_id: row.to_account_id,
    transaction_ids: row.transaction_ids,
    previous_assignments: row.previous_assignments,
    selected_count: Number(row.selected_count),
    changed_count: Number(row.changed_count),
    created_at: row.created_at,
    replayed,
  };
}

async function retagPortfolioTransactions(request: RetagRequest) {
  const transactionIds = [...request.transaction_ids].sort((a, b) => a - b);
  const fingerprint = fingerprintRetagRequest({
    ...request,
    transaction_ids: transactionIds,
  });

  return withTransaction(async () => {
    const replay = await repository.getAuditByIdempotencyKey(
      request.idempotency_key,
    );
    if (replay) {
      if (replay.request_fingerprint !== fingerprint) {
        throw new ConflictError(
          "idempotency_key was already used for a different broker re-tag request",
        );
      }
      return mapReceipt(replay, true);
    }

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

    // A same-key request may have committed while this transaction waited for
    // either lock, so repeat the audit lookup after serialization.
    const priorAudit = await repository.getAuditByIdempotencyKey(
      request.idempotency_key,
    );
    if (priorAudit) {
      if (priorAudit.request_fingerprint !== fingerprint) {
        throw new ConflictError(
          "idempotency_key was already used for a different broker re-tag request",
        );
      }
      return mapReceipt(priorAudit, true);
    }

    const selected = await repository.lockTransactions(transactionIds);
    const selectedById = new Map(selected.map((row) => [Number(row.id), row]));
    const stale = transactionIds.filter((id) => {
      const row = selectedById.get(id);
      return (
        !row ||
        (row.account_id == null ? null : Number(row.account_id)) !==
          request.from_account_id
      );
    });
    if (stale.length > 0) {
      throw new ConflictError(
        "selected portfolio transactions are missing or no longer have the expected broker assignment",
        { details: { stale_transaction_ids: stale } },
      );
    }

    const investmentIds = Array.from(
      new Set(selected.map((row) => Number(row.investment_id))),
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

    const audit = await repository.insertAudit({
      idempotency_key: request.idempotency_key,
      request_fingerprint: fingerprint,
      from_account_id: request.from_account_id,
      to_account_id: request.to_account_id,
      transaction_ids: transactionIds,
      previous_assignments: transactionIds.map((id) => ({
        transaction_id: id,
        account_id: request.from_account_id,
      })),
      selected_count: transactionIds.length,
      changed_count: changedIds.length,
    });
    await appendAuditEvent({
      stream: "portfolio_retag",
      event: "receipt_created",
      receipt_id: String(audit.id),
      occurred_at: audit.occurred_at,
      idempotency_key: audit.idempotency_key,
      request_fingerprint: audit.request_fingerprint,
      from_account_id: audit.from_account_id,
      to_account_id: audit.to_account_id,
      transaction_ids: audit.transaction_ids,
      previous_assignments: audit.previous_assignments,
      selected_count: audit.selected_count,
      changed_count: audit.changed_count,
    });
    return mapReceipt(audit, false);
  });
}

export default { retagPortfolioTransactions };

export {
  assertRetagPreservesPartitionUnits as __assertRetagPreservesPartitionUnits,
  assertRetagPreservesPortfolioEconomics as __assertRetagPreservesPortfolioEconomics,
  fingerprintRetagRequest as __fingerprintRetagRequest,
  retagPortfolioTransactions as __retagPortfolioTransactions,
};
