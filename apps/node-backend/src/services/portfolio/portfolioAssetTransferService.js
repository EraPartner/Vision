/** Atomic import-only dated transfers, preserving original acquisition basis. */
import {
  areLotsFullyAssigned,
  partitionOversellDeficits,
  projectAssetTransferPartitions,
} from "@vision/shared-utils/portfolio";
import {
  ConflictError,
  ValidationError,
} from "../../middleware/errorHandler.js";
import { query, withTransaction } from "../../database/connection.js";
import { toDecimal } from "../../lib/money.js";
import { toYmd } from "../../lib/dateFormat.js";
import { getUnitEventsForInvestment } from "../../repositories/portfolioTxRepo.reads.js";
import { portfolioCustodyWriteHistory } from "./portfolioCustodyImportScope.js";
import {
  deleteAssetTransfersForBatch,
  findAssetTransferFingerprint,
  getAssetTransfersForBatch,
  insertAssetTransfer,
} from "../../repositories/portfolioAssetTransferRepository.js";

function configOf(row, batch) {
  const raw = batch?.custom_config ?? row.custom_config;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw || {};
  } catch {
    return {};
  }
}

/** Pure preparation, also used by the global reconciliation planner. */
export function previewPortfolioAssetTransfer(row, batch) {
  const config = configOf(row, batch);
  const details = row.asset_transfer_details;
  if (!details || !["in", "out"].includes(details.direction))
    return { error: "unresolved_transfer_direction" };
  const incoming = details.direction === "in";
  const ownAccount = Number(batch?.account_id ?? row.account_id);
  const source = incoming
    ? Number(config.transfer_origin_account_id)
    : ownAccount;
  const destination = incoming
    ? ownAccount
    : Number(config.transfer_destination_account_id);
  const investment = Number(
    row.user_override_investment_id ??
      row.resolved_investment_id ??
      row.investment_id,
  );
  if (
    !Number.isInteger(source) ||
    source <= 0 ||
    !Number.isInteger(destination) ||
    destination <= 0 ||
    source === destination
  )
    return {
      error: incoming
        ? "unresolved_transfer_origin"
        : "unresolved_transfer_destination",
    };
  if (
    !Number.isInteger(investment) ||
    investment <= 0 ||
    !row.tx_date ||
    !toDecimal(row.units || 0).gt(0)
  )
    return { error: "incomplete_transfer" };
  if (
    details.basisStatus !== "carried" ||
    toDecimal(details.feeUnits || 0).lt(0) ||
    toDecimal(details.feeUnits || 0).gte(row.units)
  )
    return { error: "unresolved_transfer_fee_basis" };
  if (
    !row.source_record_hash ||
    !row.dedup_fingerprint ||
    !row.dedup_fingerprint_version
  )
    return { error: "missing_transfer_identity" };
  return {
    event: {
      id: Number.MAX_SAFE_INTEGER,
      type: "asset_transfer",
      investment_id: investment,
      source_account_id: source,
      destination_account_id: destination,
      date:
        row.tx_date instanceof Date
          ? toYmd(row.tx_date)
          : String(row.tx_date).slice(0, 10),
      units: String(row.units),
      fee_units: String(details.feeUnits || 0),
      amount: "0",
      fees: "0",
      taxes: "0",
      import_batch_id: Number(row.batch_id ?? batch?.id),
      staging_row_id: Number(row.id),
      source_record_hash: row.source_record_hash,
      dedup_fingerprint: row.dedup_fingerprint,
      dedup_fingerprint_version: row.dedup_fingerprint_version,
    },
  };
}

/** Validate chronology and custody independently from cost-basis selection. */
export function validatePortfolioAssetTransferHistory(rows) {
  if (
    !rows.some((row) =>
      ["asset_transfer", "asset_adjustment"].includes(row.type),
    )
  )
    return;
  if (!areLotsFullyAssigned(rows))
    throw new ConflictError(
      "Asset custody events require the original acquisitions to be reconciled to their source accounts",
    );
  try {
    for (const method of /** @type {import('@vision/shared-utils/portfolio').CostBasisMethod[]} */ ([
      "weighted_avg",
      "fifo",
      "lifo",
    ]))
      projectAssetTransferPartitions(rows, method);
    if (partitionOversellDeficits(rows).size > 0)
      throw new Error("Custody history contains an oversell");
  } catch (error) {
    throw new ConflictError(
      `Asset transfer custody history is invalid: ${error.message}`,
    );
  }
}

/** Caller may supply an outer reconciliation transaction; nested scopes join it. */
export async function commitPortfolioAssetTransfer({ row, batch }) {
  const prepared = previewPortfolioAssetTransfer(row, batch);
  if (prepared.error)
    throw new ValidationError(
      `Asset transfer requires repair: ${prepared.error}`,
    );
  const event = prepared.event;
  return withTransaction(async (client) => {
    const accounts = (
      await query(
        "SELECT id,is_active,type FROM accounts WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE",
        [[event.source_account_id, event.destination_account_id]],
      )
    ).rows;
    if (
      accounts.length !== 2 ||
      accounts.some(
        (account) =>
          !account.is_active ||
          !["brokerage", "crypto_exchange", "wallet"].includes(account.type),
      )
    )
      throw new ConflictError("Asset transfer accounts must be active");
    await query(
      "LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE",
    );
    const existing = await findAssetTransferFingerprint(
      event.dedup_fingerprint,
      event.dedup_fingerprint_version,
    );
    if (existing) {
      for (const field of [
        "investment_id",
        "source_account_id",
        "destination_account_id",
        "date",
        "units",
        "fee_units",
      ]) {
        const matches = ["units", "fee_units"].includes(field)
          ? toDecimal(existing[field]).eq(event[field])
          : String(existing[field]) === String(event[field]);
        if (!matches)
          throw new ConflictError(
            "Asset transfer source identity conflicts with existing custody history",
          );
      }
      return { id: Number(existing.id), duplicate: true };
    }
    const history = portfolioCustodyWriteHistory(
      await getUnitEventsForInvestment(event.investment_id),
      event,
      client,
    );
    validatePortfolioAssetTransferHistory([...history, event]);
    event.fee_basis_allocations = {};
    const methods =
      /** @type {import('@vision/shared-utils/portfolio').CostBasisMethod[]} */ ([
        "weighted_avg",
        "fifo",
        "lifo",
      ]);
    for (const method of methods) {
      const projected = projectAssetTransferPartitions(
        [...history, event],
        method,
      );
      const leg = projected
        .get(event.source_account_id)
        .find(
          (row) =>
            row.type === "transfer_out" &&
            row.staging_row_id === event.staging_row_id,
        );
      event.fee_basis_allocations[method] = {
        feeUnits: event.fee_units,
        lots: leg.assetFeeLots
          .filter((lot) => lot.units.gt(0))
          .map((lot) => ({
            acquisitionId: Number(lot.acquisitionId),
            acquisitionDate: lot.acquiredDate,
            currency: lot.currency,
            units: lot.units.toString(),
            nativeBasis: lot.costBasis.toString(),
            eurBasis: lot.fxResolved ? lot.costBasisConv.toString() : null,
          })),
      };
    }
    const inserted = await insertAssetTransfer(event);
    return { id: Number(inserted.id), duplicate: false };
  });
}

/** Undo the complete canonical event after validating every downstream sale. */
export async function rollbackPortfolioAssetTransfersForBatch(
  batchId,
  { omitTransactionIds = [], skipHistoryValidation = false } = {},
) {
  return withTransaction(async () => {
    await query(
      "LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE",
    );
    const removed = await getAssetTransfersForBatch(batchId);
    const transferIds = new Set(removed.map((event) => String(event.id)));
    const omitted = new Set(omitTransactionIds.map(Number));
    for (const investmentId of new Set(
      removed.map((event) => Number(event.investment_id)),
    )) {
      if (skipHistoryValidation) continue;
      const before = await getUnitEventsForInvestment(investmentId);
      const after = before.filter((row) =>
        row.type === "asset_transfer"
          ? !transferIds.has(String(row.transfer_id))
          : !omitted.has(Number(row.id)),
      );
      validatePortfolioAssetTransferHistory(after);
      const prior = partitionOversellDeficits(before);
      for (const [account, deficit] of partitionOversellDeficits(after))
        if (deficit > (prior.get(account) ?? 0))
          throw new ConflictError(
            "Transfer rollback would invalidate downstream holdings",
          );
    }
    return deleteAssetTransfersForBatch(batchId);
  });
}
