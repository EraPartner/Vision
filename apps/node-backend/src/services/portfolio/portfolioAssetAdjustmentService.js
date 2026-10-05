/** Source-backed unit corrections, preserving the original acquisition basis. */
import { projectAssetTransferPartitions } from "@vision/shared-utils/portfolio";
import { query, withTransaction } from "../../database/connection.js";
import { toDecimal } from "../../lib/money.js";
import { toYmd } from "../../lib/dateFormat.js";
import {
  ConflictError,
  ValidationError,
} from "../../middleware/errorHandler.js";
import { getUnitEventsForInvestment } from "../../repositories/portfolioTxRepo.reads.js";
import { validatePortfolioAssetTransferHistory } from "./portfolioAssetTransferService.js";
import { portfolioCustodyWriteHistory } from "./portfolioCustodyImportScope.js";
import {
  findAssetAdjustmentFingerprint,
  getEligibleYieldSources,
  retainAssetAdjustmentSources,
  insertAssetAdjustment,
  getAssetAdjustmentsForBatch,
  deleteAssetAdjustmentsForBatch,
} from "../../repositories/portfolioAssetAdjustmentRepository.js";

export function previewPortfolioAssetAdjustment(
  row,
  batch,
  { sourceRows = [] } = {},
) {
  const details = row.asset_adjustment_details;
  const account = Number(
    details?.accountId ?? batch?.account_id ?? row.account_id,
  );
  const investment = Number(
    row.user_override_investment_id ??
      row.resolved_investment_id ??
      row.investment_id,
  );
  if (!details || !["yield_reversal", "asset_fee"].includes(details.kind))
    return { error: "unresolved_adjustment_kind" };
  const reversal = details.kind === "yield_reversal";
  const rawConfig = batch?.custom_config ?? row.custom_config;
  let config;
  try {
    config =
      typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig || {};
  } catch {
    config = {};
  }
  if (reversal && config.yield_basis_policy !== "zero")
    return { error: "unresolved_zero_yield_policy" };
  if (details.basisPolicy !== (reversal ? "zero_yield_only" : "carried"))
    return { error: "unresolved_adjustment_basis" };
  if (
    !Number.isInteger(account) ||
    account <= 0 ||
    !Number.isInteger(investment) ||
    investment <= 0 ||
    !row.tx_date ||
    !toDecimal(row.units || 0).gt(0)
  )
    return { error: "incomplete_adjustment" };
  if (
    !row.source_record_hash ||
    !row.dedup_fingerprint ||
    !row.dedup_fingerprint_version
  )
    return { error: "missing_adjustment_identity" };
  const eligibleHashes = [
    ...new Set(
      [
        ...(details.eligibleSourceRecordHashes || []),
        ...sourceRows
          .filter(
            (source) =>
              Number(source.account_id) === account &&
              Number(source.investment_id ?? source.resolved_investment_id) ===
                investment &&
              source.asset_adjustment_details?.kind === "yield_acquisition" &&
              source.asset_adjustment_details?.basisPolicy === "zero",
          )
          .map((source) => source.source_record_hash),
      ].filter((hash) => /^[a-f0-9]{64}$/.test(hash)),
    ),
  ].sort();
  return {
    event: {
      id: Number.MAX_SAFE_INTEGER,
      type: "asset_adjustment",
      account_id: account,
      investment_id: investment,
      units: String(row.units),
      amount: "0",
      fees: "0",
      taxes: "0",
      date:
        row.tx_date instanceof Date
          ? toYmd(row.tx_date)
          : String(row.tx_date).slice(0, 10),
      adjustment_kind: details.kind,
      basis_policy: details.basisPolicy,
      eligible_source_record_hashes: reversal ? eligibleHashes : [],
      import_batch_id: Number(row.batch_id ?? batch?.id),
      staging_row_id: Number(row.id),
      source_record_hash: row.source_record_hash,
      dedup_fingerprint: row.dedup_fingerprint,
      dedup_fingerprint_version: row.dedup_fingerprint_version,
    },
  };
}

export async function commitPortfolioAssetAdjustment({ row, batch }) {
  const prepared = previewPortfolioAssetAdjustment(row, batch);
  if (prepared.error)
    throw new ValidationError(
      `Asset adjustment requires repair: ${prepared.error}`,
    );
  const event = prepared.event;
  return withTransaction(async (client) => {
    const account = (
      await query(
        "SELECT id,is_active,type FROM accounts WHERE id=$1 FOR UPDATE",
        [event.account_id],
      )
    ).rows[0];
    if (
      !account?.is_active ||
      !["brokerage", "crypto_exchange", "wallet"].includes(account.type)
    )
      throw new ConflictError(
        "Asset adjustment account must be active and support custody",
      );
    await query(
      "LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE",
    );
    const existing = await findAssetAdjustmentFingerprint(
      event.dedup_fingerprint,
      event.dedup_fingerprint_version,
    );
    if (existing) {
      for (const field of [
        "investment_id",
        "account_id",
        "date",
        "units",
        "adjustment_kind",
        "basis_policy",
      ])
        if (
          !(field === "units"
            ? toDecimal(existing[field]).eq(event[field])
            : String(existing[field]) === String(event[field]))
        )
          throw new ConflictError(
            "Asset adjustment identity conflicts with existing unit history",
          );
      return { id: Number(existing.id), duplicate: true };
    }
    const sources =
      event.adjustment_kind === "yield_reversal"
        ? await getEligibleYieldSources(event.investment_id, event.account_id)
        : [];
    event.eligible_source_record_hashes = sources.map(
      (source) => source.source_record_hash,
    );
    const history = portfolioCustodyWriteHistory(
      await getUnitEventsForInvestment(event.investment_id),
      event,
      client,
    );
    validatePortfolioAssetTransferHistory([...history, event]);
    event.basis_allocations = {};
    for (const method of /** @type {import('@vision/shared-utils/portfolio').CostBasisMethod[]} */ ([
      "weighted_avg",
      "fifo",
      "lifo",
    ])) {
      const leg = projectAssetTransferPartitions([...history, event], method)
        .get(event.account_id)
        .find(
          (candidate) =>
            candidate.staging_row_id === event.staging_row_id &&
            ["unit_reversal", "asset_fee"].includes(candidate.type),
        );
      event.basis_allocations[method] = {
        units: event.units,
        lots: leg.consumedLots.map((lot) => ({
          acquisitionId: Number(lot.acquisitionId),
          acquisitionDate: lot.acquiredDate,
          sourceRecordHash: lot.sourceRecordHash,
          currency: lot.currency,
          units: lot.units.toString(),
          nativeBasis: lot.costBasis.toString(),
          eurBasis: lot.costBasis.eq(0)
            ? "0"
            : lot.fxResolved
              ? lot.costBasisConv.toString()
              : null,
        })),
      };
    }
    const inserted = await insertAssetAdjustment(event);
    await retainAssetAdjustmentSources(inserted.id, sources);
    return { id: Number(inserted.id), duplicate: false };
  });
}

export async function rollbackPortfolioAssetAdjustmentsForBatch(
  batchId,
  { omitTransactionIds = [], skipHistoryValidation = false } = {},
) {
  return withTransaction(async () => {
    await query(
      "LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE",
    );
    const removed = await getAssetAdjustmentsForBatch(batchId);
    const removedIds = new Set(removed.map((row) => Number(row.id)));
    const omitted = new Set(omitTransactionIds.map(Number));
    if (!skipHistoryValidation)
      for (const investmentId of new Set(
        removed.map((row) => Number(row.investment_id)),
      )) {
        const history = await getUnitEventsForInvestment(investmentId);
        validatePortfolioAssetTransferHistory(
          history.filter(
            (row) =>
              !removedIds.has(Number(row.id)) && !omitted.has(Number(row.id)),
          ),
        );
      }
    return deleteAssetAdjustmentsForBatch(batchId);
  });
}
