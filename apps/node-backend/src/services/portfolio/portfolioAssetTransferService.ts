/** Atomic import-only dated transfers, preserving original acquisition basis. */
import {
  areLotsFullyAssigned,
  partitionOversellDeficits,
  projectAssetTransferPartitions,
} from "@vision/shared-utils/portfolio";
import type {
  CostBasisMethod,
  PartitionedTxnLike,
} from "@vision/shared-utils/portfolio";
import {
  ConflictError,
  ValidationError,
} from "../../middleware/errorHandler.ts";
import { query, withTransaction } from "../../database/connection.ts";
import { toDecimal } from "../../lib/money.ts";
import { toYmd } from "../../lib/dateFormat.ts";
import { getUnitEventsForInvestment } from "../../repositories/portfolioTxRepo.reads.ts";
import type { PortfolioUnitEventRow } from "../../repositories/portfolioTxRepo.reads.ts";
import { portfolioCustodyWriteHistory } from "./portfolioCustodyImportScope.ts";
import { asPartitionedTxns } from "./portfolioTransactionRules.ts";
import {
  deleteAssetTransfersForBatch,
  findAssetTransferFingerprint,
  getAssetTransfersForBatch,
  insertAssetTransfer,
} from "../../repositories/portfolioAssetTransferRepository.ts";

/**
 * The staging-row columns a custody preview reads (asset transfers and asset
 * adjustments alike). NUMERIC/BIGINT columns may arrive as pg strings.
 */
export type CustodyStagingRow = {
  id: number | string;
  batch_id?: number | string | null;
  account_id?: number | string | null;
  investment_id?: number | string | null;
  resolved_investment_id?: number | string | null;
  user_override_investment_id?: number | string | null;
  /** JSONB object, or its JSON text. */
  custom_config?: unknown;
  tx_date: Date | string | null;
  units: string | number | null;
  source_record_hash?: string | null;
  dedup_fingerprint?: string | null;
  dedup_fingerprint_version?: number | null;
};

/** The import batch columns a custody preview reads. */
export type CustodyBatch = {
  id?: number | string;
  account_id?: number | string | null;
  /** JSONB object, or its JSON text. */
  custom_config?: unknown;
};

/** `asset_transfer_details` JSONB as staged by the importer. */
export type AssetTransferDetails = {
  direction?: string;
  networkBinding?: { originAccountId?: number | string } | null;
  basisStatus?: string;
  feeUnits?: number | string;
};

/** The import configuration keys a transfer preview reads. */
type TransferImportConfig = {
  transfer_origin_account_id?: number | string;
  transfer_destination_account_id?: number | string;
};

/** One cost-basis method's allocation of the fee units' acquisition lots. */
export type FeeBasisAllocation = {
  feeUnits: string;
  lots: {
    acquisitionId: number;
    acquisitionDate: string;
    currency: string | undefined;
    units: string;
    nativeBasis: string;
    eurBasis: string | null;
  }[];
};

/** A previewed `portfolio_asset_transfers` event, shaped as a unit-event row. */
export type AssetTransferEvent = {
  id: number;
  type: "asset_transfer";
  investment_id: number;
  source_account_id: number;
  destination_account_id: number;
  /** 'YYYY-MM-DD' */
  date: string;
  units: string;
  fee_units: string;
  amount: "0";
  fees: "0";
  taxes: "0";
  import_batch_id: number;
  staging_row_id: number;
  source_record_hash: string;
  dedup_fingerprint: string;
  dedup_fingerprint_version: number;
  fee_basis_allocations?: Partial<Record<CostBasisMethod, FeeBasisAllocation>>;
};

export type AssetTransferPreview =
  | {
      error:
        | "unresolved_transfer_direction"
        | "unresolved_transfer_origin"
        | "unresolved_transfer_destination"
        | "incomplete_transfer"
        | "unresolved_transfer_fee_basis"
        | "missing_transfer_identity";
      event?: undefined;
    }
  | { error?: undefined; event: AssetTransferEvent };

/** A unit-history row the custody validator replays. */
export type CustodyHistoryRow = PortfolioUnitEventRow | PartitionedTxnLike;

function configOf(
  row: CustodyStagingRow,
  batch: CustodyBatch | undefined,
): TransferImportConfig {
  const raw = batch?.custom_config ?? row.custom_config;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw || {};
  } catch {
    return {};
  }
}

/** Pure preparation, also used by the global reconciliation planner. */
export function previewPortfolioAssetTransfer(
  row: CustodyStagingRow & {
    asset_transfer_details?: AssetTransferDetails | null;
  },
  batch?: CustodyBatch,
): AssetTransferPreview {
  const config = configOf(row, batch);
  const details = row.asset_transfer_details;
  if (!details || (details.direction !== "in" && details.direction !== "out"))
    return { error: "unresolved_transfer_direction" };
  const incoming = details.direction === "in";
  const ownAccount = Number(batch?.account_id ?? row.account_id);
  const source = incoming
    ? Number(
        details.networkBinding?.originAccountId ??
          config.transfer_origin_account_id,
      )
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
    toDecimal(details.feeUnits || 0).gte(toDecimal(row.units))
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
export function validatePortfolioAssetTransferHistory(
  rows: readonly CustodyHistoryRow[],
): void {
  if (
    !rows.some((row) =>
      ["asset_transfer", "asset_adjustment"].includes(row.type),
    )
  )
    return;
  const txns = asPartitionedTxns(rows);
  if (!areLotsFullyAssigned(txns))
    throw new ConflictError(
      "Asset custody events require the original acquisitions to be reconciled to their source accounts",
    );
  try {
    for (const method of [
      "weighted_avg",
      "fifo",
      "lifo",
    ] satisfies CostBasisMethod[])
      projectAssetTransferPartitions(txns, method);
    if (partitionOversellDeficits(txns).size > 0)
      throw new Error("Custody history contains an oversell");
  } catch (error) {
    throw new ConflictError(
      `Asset transfer custody history is invalid: ${(error as Error).message}`,
    );
  }
}

/** Caller may supply an outer reconciliation transaction; nested scopes join it. */
export async function commitPortfolioAssetTransfer({
  row,
  batch,
}: {
  row: Parameters<typeof previewPortfolioAssetTransfer>[0];
  batch?: CustodyBatch;
}): Promise<{ id: number; duplicate: boolean }> {
  const prepared = previewPortfolioAssetTransfer(row, batch);
  if (prepared.error)
    throw new ValidationError(
      `Asset transfer requires repair: ${prepared.error}`,
    );
  const event = prepared.event;
  return withTransaction(async (client) => {
    const accounts = (
      await query<{ id: number; is_active: boolean; type: string }>(
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
      ] as const) {
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
    const methods: CostBasisMethod[] = ["weighted_avg", "fifo", "lifo"];
    for (const method of methods) {
      const projected = projectAssetTransferPartitions(
        asPartitionedTxns([...history, event]),
        method,
      );
      // The history just validated includes this event, so its source
      // partition holds the transfer_out leg with its fee lots.
      const leg = projected
        .get(event.source_account_id)!
        .find(
          (row) =>
            row.type === "transfer_out" &&
            row.staging_row_id === event.staging_row_id,
        )!;
      event.fee_basis_allocations[method] = {
        feeUnits: event.fee_units,
        lots: leg
          .assetFeeLots!.filter((lot) => lot.units.gt(0))
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
  batchId: number | string,
  {
    omitTransactionIds = [],
    skipHistoryValidation = false,
  }: {
    omitTransactionIds?: readonly (number | string)[];
    skipHistoryValidation?: boolean;
  } = {},
): Promise<number | null> {
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
      const prior = partitionOversellDeficits(asPartitionedTxns(before));
      for (const [account, deficit] of partitionOversellDeficits(
        asPartitionedTxns(after),
      ))
        if (deficit > (prior.get(account) ?? 0))
          throw new ConflictError(
            "Transfer rollback would invalidate downstream holdings",
          );
    }
    return deleteAssetTransfersForBatch(batchId);
  });
}
