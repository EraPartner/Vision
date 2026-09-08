import crypto from "node:crypto";
import { withTransaction } from "../../database/connection.js";
import repository from "../../repositories/portfolioBrokerRetagRepository.js";
import {
  buildInvestmentSummaryCorePartitioned,
  partitionOversellDeficits,
} from "@vision/shared-utils/portfolio";
import { settingsRepository } from "../../repositories/settingsRepository.js";
import { todayAppDateString } from "../../lib/timezone.js";
import {
  ConflictError,
  ValidationError,
} from "../../middleware/errorHandler.js";

const EPSILON = 1e-8;
const COST_BASIS_METHODS = new Set(["weighted_avg", "fifo", "lifo"]);

function buildRateIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const currency = String(row.currency_code).toUpperCase();
    const entries = index.get(currency) ?? [];
    entries.push({ date: row.rate_date, rate: Number(row.rate_to_eur) });
    index.set(currency, entries);
  }
  return index;
}

function rateOnOrBefore(index, currency, date) {
  if (currency === "EUR") return 1;
  const entries = index.get(currency) ?? [];
  let match;
  for (const entry of entries) {
    if (entry.date > date) break;
    if (Number.isFinite(entry.rate) && entry.rate > 0) match = entry.rate;
  }
  return match ?? entries.at(-1)?.rate;
}

/** @param {object} value */
export function fingerprintRetagRequest(value) {
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
 *
 * @param {any[]} rows
 * @param {Set<number>} selectedIds
 * @param {number|null} toAccountId
 */
export function assertRetagPreservesPartitionUnits(
  rows,
  selectedIds,
  toAccountId,
) {
  const byInvestment = new Map();
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
    const before = partitionOversellDeficits(beforeRows);
    const after = partitionOversellDeficits(afterRows);
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
 *
 * @param {any[]} rows
 * @param {Set<number>} selectedIds
 * @param {number|null} toAccountId
 * @param {"weighted_avg"|"fifo"|"lifo"} costBasisMethod
 * @param {string} todayYmd
 * @param {any[]} historicalRates
 */
export function assertRetagPreservesPortfolioEconomics(
  rows,
  selectedIds,
  toAccountId,
  costBasisMethod,
  todayYmd,
  historicalRates = [],
) {
  const rateIndex = buildRateIndex(historicalRates);
  const targets = new Set(["EUR", ...rateIndex.keys()]);
  const byInvestment = new Map();
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
      beforeRows,
      options,
    ).core;
    const after = buildInvestmentSummaryCorePartitioned(
      investment,
      afterRows,
      options,
    ).core;
    for (const field of ["totalUnits", "totalInvested", "realizedGain"]) {
      if (after[field].minus(before[field]).abs().gt(EPSILON)) {
        throw new ValidationError(
          `re-tag would change ${field} for investment ${investmentId} under ${costBasisMethod} cost basis`,
        );
      }
    }
    for (const target of targets) {
      const withTargetFx = (rowsToAnnotate) =>
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
                : sourceRate / targetRate;
          if (!Number.isFinite(fxMultiplier) || fxMultiplier <= 0) {
            throw new ValidationError(
              `re-tag cannot verify ${target} cost basis for investment ${investmentId}`,
            );
          }
          return { ...row, fxMultiplier };
        });
      const beforeTarget = buildInvestmentSummaryCorePartitioned(
        investment,
        withTargetFx(beforeRows),
        options,
      ).core.converted;
      const afterTarget = buildInvestmentSummaryCorePartitioned(
        investment,
        withTargetFx(afterRows),
        options,
      ).core.converted;
      for (const field of ["totalInvested", "realizedGain"]) {
        if (afterTarget[field].minus(beforeTarget[field]).abs().gt(EPSILON)) {
          throw new ValidationError(
            `re-tag would change ${target} ${field} for investment ${investmentId} under ${costBasisMethod} cost basis`,
          );
        }
      }
    }
  }
}

async function resolveCostBasisMethod() {
  try {
    const value = await settingsRepository.get("cost_basis_method");
    return COST_BASIS_METHODS.has(value) ? value : "weighted_avg";
  } catch {
    return "weighted_avg";
  }
}

function mapReceipt(row, replayed) {
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

/**
 * @param {{ transaction_ids:number[], from_account_id:number|null, to_account_id:number|null, idempotency_key:string }} request
 */
export async function retagPortfolioTransactions(request) {
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
    return mapReceipt(audit, false);
  });
}

export default { retagPortfolioTransactions };
