/** Explicit history reads, compare-and-set adoption, and immutable receipts. */
import { query } from "../database/connection.ts";
import { checkRows, queryOne, queryRows } from "../database/rowContracts.ts";
import {
  batchAccountIdRowSchema,
  batchConfigFields,
  bigintIdRowSchema,
  reconciliationAdjustmentRowSchema,
  reconciliationBatchScopeRowSchema,
  reconciliationJournalRowSchema,
  reconciliationSnapshotRowSchema,
  reconciliationSourceRowSchema,
  reconciliationTransferRowSchema,
} from "../database/rows/portfolioImport.ts";
import type {
  PortfolioTransactionSnapshot,
  ReconciliationBatchScopeRow,
  ReconciliationJournalRow,
  ReconciliationSourceRow,
} from "../database/rows/portfolioImport.ts";
import type { PortfolioAssetAdjustmentRow } from "./portfolioAssetAdjustmentRepository.ts";
import type { PortfolioAssetTransferRow } from "./portfolioAssetTransferRepository.ts";

export type {
  PortfolioTransactionSnapshot,
  ReconciliationBatchScopeRow,
  ReconciliationJournalRow,
  ReconciliationSourceRow,
};

type Id = number | string;

/** Custody events projected onto the transaction-history shape. */
export type ReconciliationTransferEvent = Omit<
  PortfolioAssetTransferRow,
  "id"
> & {
  id: number;
  transfer_id: number;
  type: "asset_transfer";
  amount: "0";
  fees: "0";
  taxes: "0";
};

export type ReconciliationAdjustmentEvent = Omit<
  PortfolioAssetAdjustmentRow,
  "id"
> & {
  id: number;
  adjustment_id: number;
  type: "asset_adjustment";
  amount: "0";
  fees: "0";
  taxes: "0";
};

export type ReconciliationHistoryEvent =
  | PortfolioTransactionSnapshot
  | ReconciliationTransferEvent
  | ReconciliationAdjustmentEvent;

// Numeric strings preserve the database's exact stored precision in receipts.
export const PORTFOLIO_TRANSACTION_SNAPSHOT_SQL = `portfolio_income_transaction_snapshot(pt)`;
const SNAPSHOT = PORTFOLIO_TRANSACTION_SNAPSHOT_SQL;

export async function lockReconciliationAccountsAndHistory(
  accountIds: readonly number[],
): Promise<void> {
  if (accountIds.length > 0)
    await query(
      "SELECT id FROM accounts WHERE id = ANY($1::integer[]) ORDER BY id FOR UPDATE",
      [accountIds],
    );
  await query(
    "LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE",
  );
}

export async function readReconciliationSources(
  batchIds: readonly Id[],
): Promise<ReconciliationSourceRow[]> {
  return queryRows(
    reconciliationSourceRowSchema,
    `SELECT s.*, to_char(s.tx_date, 'YYYY-MM-DD') AS tx_date,
            COALESCE(s.user_override_investment_id, s.resolved_investment_id) AS investment_id,
            i.asset_class, i.currency AS investment_currency,
            b.account_id, b.custom_config, b.adapter_name, b.status AS batch_status
       FROM portfolio_import_staging_rows s
       JOIN portfolio_import_batches b ON b.id = s.batch_id
       LEFT JOIN investments i
         ON i.id = COALESCE(s.user_override_investment_id, s.resolved_investment_id)
      WHERE s.batch_id = ANY($1::bigint[])
      ORDER BY s.batch_id, s.row_index, s.id`,
    [batchIds],
  );
}

export async function readReconciliationHistory(
  investmentIds: readonly number[],
): Promise<ReconciliationHistoryEvent[]> {
  if (investmentIds.length === 0) return [];
  const rows = await queryRows(
    reconciliationSnapshotRowSchema,
    `SELECT ${SNAPSHOT} AS snapshot
       FROM portfolio_transactions pt
      WHERE pt.investment_id = ANY($1::int[])
      ORDER BY pt.investment_id, pt.date, pt.id`,
    [investmentIds],
  );
  const transfers = await queryRows(
    reconciliationTransferRowSchema,
    `SELECT t.*, to_char(t.date, 'YYYY-MM-DD') AS date
    FROM portfolio_asset_transfers t WHERE t.investment_id = ANY($1::integer[]) ORDER BY t.investment_id, t.date, t.id`,
    [investmentIds],
  );
  const adjustments = await queryRows(
    reconciliationAdjustmentRowSchema,
    "SELECT a.*,to_char(a.date,'YYYY-MM-DD') AS date FROM portfolio_asset_adjustments a WHERE investment_id=ANY($1::integer[]) ORDER BY a.investment_id,a.date,a.id",
    [investmentIds],
  );
  return [
    ...rows.map((row) => row.snapshot),
    ...transfers.map((row): ReconciliationTransferEvent => ({
      ...row,
      id: Number(row.id),
      transfer_id: Number(row.id),
      type: "asset_transfer",
      amount: "0",
      fees: "0",
      taxes: "0",
    })),
    ...adjustments.map((row): ReconciliationAdjustmentEvent => ({
      ...row,
      id: Number(row.id),
      adjustment_id: Number(row.id),
      type: "asset_adjustment",
      amount: "0",
      fees: "0",
      taxes: "0",
    })),
  ];
}

export async function readReconciliationBatchScope(
  batchIds: readonly Id[],
): Promise<ReconciliationBatchScopeRow[]> {
  return queryRows(
    reconciliationBatchScopeRowSchema,
    `SELECT id, account_id, status, custom_config, adapter_name, rows_total
       FROM portfolio_import_batches
      WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [batchIds],
  );
}

/** Minimal history shape the Kinesis and Saxo context readers inspect. */
export type ReconciliationHistoryLike = {
  id: Id;
  type: string;
  import_batch_id?: Id | null;
  dedup_fingerprint?: string | null;
};

export type ReconciliationContext = {
  sources: ReconciliationSourceRow[];
  batches: ReconciliationBatchScopeRow[];
};

export type ReconciliationReceiptContext = ReconciliationContext & {
  receipts: ReconciliationJournalRow[];
};

/** Custody owners retain the exact supplementary native wallet source binding. */
export async function readKinesisNetworkContext(
  history: readonly ReconciliationHistoryLike[],
): Promise<ReconciliationContext> {
  const ids = [
    ...new Set(
      history
        .filter((row) => row.type === "asset_transfer")
        .map((row) => Number(row.import_batch_id))
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return { sources: [], batches: [] };
  const owners = await readReconciliationSources(ids);
  const witnessIds = owners
    .map((row) =>
      Number(row.asset_transfer_details?.networkBinding?.witnessBatchId),
    )
    .filter(Boolean);
  const batchIds = [...new Set([...ids, ...witnessIds])].sort((a, b) => a - b);
  const [sources, batches] = await Promise.all([
    readReconciliationSources(batchIds),
    readReconciliationBatchScope(batchIds),
  ]);
  return { sources, batches };
}

/** Native gift group owners include generic source batches, not broker-only context. */
export async function readKinesisNativeGiftContext(
  history: readonly ReconciliationHistoryLike[],
): Promise<ReconciliationReceiptContext> {
  const ids = history
    .filter((row) => row.type === "gift" && row.dedup_fingerprint)
    .map((row) => Number(row.id));
  if (!ids.length) return { receipts: [], sources: [], batches: [] };
  const receipts = await queryRows(
    reconciliationJournalRowSchema,
    `SELECT a.* FROM portfolio_import_reconciliation_journal a
     JOIN portfolio_import_staging_rows s ON s.id=a.staging_row_id
     WHERE a.transaction_id=ANY($1::integer[]) AND a.action='adopt'
       AND s.asset_transfer_details::jsonb ? 'nativeGiftGroupReceipt'
       AND NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)
     ORDER BY a.batch_id,a.id`,
    [ids],
  );
  const batchIds = [
    ...new Set([
      ...receipts.map((row) => Number(row.batch_id)),
      ...history
        .filter((row) => row.type === "gift" && row.import_batch_id != null)
        .map((row) => Number(row.import_batch_id)),
    ]),
  ].sort((a, b) => a - b);
  if (!batchIds.length) return { receipts, sources: [], batches: [] };
  const [allSources, allBatches] = await Promise.all([
    readReconciliationSources(batchIds),
    readReconciliationBatchScope(batchIds),
  ]);
  const retainedIds = new Set(
    allSources
      .filter((row) => row.asset_transfer_details?.nativeGiftGroupReceipt)
      .map((row) => Number(row.batch_id)),
  );
  return {
    receipts,
    sources: allSources.filter((row) => retainedIds.has(Number(row.batch_id))),
    batches: allBatches.filter((row) => retainedIds.has(Number(row.id))),
  };
}

export async function retainKinesisNetworkBinding({
  before,
  after,
}: {
  before: ReconciliationSourceRow;
  after: Pick<ReconciliationSourceRow, "units" | "asset_transfer_details">;
}): Promise<boolean> {
  return (
    (
      await query(
        `UPDATE portfolio_import_staging_rows SET route='asset_transfer',type=NULL,type_raw='AssetTransfer',units=$2,asset_transfer_details=$3
     WHERE id=$1 AND status='matched' AND route=$4 AND units=$5 AND raw_data=$6 AND source_record_hash=$7 AND dedup_fingerprint=$8 RETURNING id`,
        [
          before.id,
          after.units,
          JSON.stringify(after.asset_transfer_details),
          before.route,
          before.units,
          before.raw_data,
          before.source_record_hash,
          before.dedup_fingerprint,
        ],
      )
    ).rows.length === 1
  );
}

export async function assertNoActiveKinesisNetworkConsumers(
  batchId: Id,
): Promise<void> {
  const result = await query(
    `SELECT t.id FROM portfolio_asset_transfers t
     JOIN portfolio_import_staging_rows s ON s.id=t.staging_row_id
     WHERE s.asset_transfer_details->'networkBinding'->>'witnessBatchId'=$1::text LIMIT 1`,
    [batchId],
  );
  if (result.rows.length)
    throw new Error(
      "Native wallet evidence is still used by an active broker transfer. Undo that transfer first.",
    );
}

/** Active Kinesis adoption images and their retained complete primary sources. */
export async function readKinesisAdoptionContext(
  history: readonly ReconciliationHistoryLike[],
): Promise<ReconciliationReceiptContext> {
  const ids = history
    .filter((row) => row.dedup_fingerprint && row.import_batch_id == null)
    .map((row) => Number(row.id));
  if (!ids.length) return { receipts: [], sources: [], batches: [] };
  const receipts = await queryRows(
    reconciliationJournalRowSchema,
    `SELECT a.* FROM portfolio_import_reconciliation_journal a
     JOIN portfolio_import_batches b ON b.id=a.batch_id
     WHERE a.transaction_id=ANY($1::integer[]) AND a.action='adopt'
       AND b.custom_config->>'format'='kinesis_transaction_history'
       AND NOT EXISTS(SELECT 1 FROM portfolio_import_reconciliation_journal r WHERE r.previous_entry_id=a.id)
     ORDER BY a.batch_id,a.id`,
    [ids],
  );
  const batchIds = [
    ...new Set(receipts.map((receipt) => Number(receipt.batch_id))),
  ];
  if (!batchIds.length) return { receipts, sources: [], batches: [] };
  let batches = await readReconciliationBatchScope(batchIds);
  const referenced = [
    ...new Set([
      ...batchIds,
      ...batches.flatMap(
        (batch) =>
          batchConfigFields(batch.custom_config)
            ?.portfolio_performance_reference?.effectiveBatchIds || [],
      ),
    ]),
  ]
    .map(Number)
    .sort((a, b) => a - b);
  if (referenced.length !== batchIds.length)
    batches = await readReconciliationBatchScope(referenced);
  const sources = await readReconciliationSources(referenced);
  return { receipts, sources, batches };
}

/** Retained source and immutable receipts that can identify a prior Saxo adoption. */
export async function readSaxoAdoptionContext(
  history: readonly ReconciliationHistoryLike[],
): Promise<ReconciliationReceiptContext> {
  const transactionIds = history
    .filter((row) => row.dedup_fingerprint && row.import_batch_id == null)
    .map((row) => Number(row.id));
  if (transactionIds.length === 0)
    return { receipts: [], sources: [], batches: [] };
  const receipts = await queryRows(
    reconciliationJournalRowSchema,
    `SELECT a.* FROM portfolio_import_reconciliation_journal a
       JOIN portfolio_import_batches b ON b.id = a.batch_id
      WHERE a.transaction_id = ANY($1::integer[]) AND a.action = 'adopt'
        AND (b.adapter_name = 'saxo_transaction_history'
          OR b.custom_config->>'format' = 'saxo_transaction_history')
        AND NOT EXISTS (SELECT 1 FROM portfolio_import_reconciliation_journal r
          WHERE r.previous_entry_id = a.id)
      ORDER BY a.batch_id, a.id`,
    [transactionIds],
  );
  const batchIds = [
    ...new Set(receipts.map((receipt) => Number(receipt.batch_id))),
  ];
  if (batchIds.length === 0) return { receipts, sources: [], batches: [] };
  const [sources, batches] = await Promise.all([
    readReconciliationSources(batchIds),
    readReconciliationBatchScope(batchIds),
  ]);
  return { receipts, sources, batches };
}

export async function readReconciledProImportAccounts(
  accountIds: readonly number[],
): Promise<number[]> {
  if (accountIds.length === 0) return [];
  const rows = await queryRows(
    batchAccountIdRowSchema,
    `SELECT DISTINCT b.account_id FROM portfolio_import_batches b
    WHERE b.account_id = ANY($1::integer[]) AND b.status = 'complete'
      AND (b.adapter_name = 'nexo_pro_spot_history' OR b.custom_config->>'format' = 'nexo_pro_spot_history')
      AND EXISTS (SELECT 1 FROM portfolio_import_staging_rows s WHERE s.batch_id = b.id
        AND s.route = 'portfolio' AND s.type IN ('buy','sell') AND s.status IN ('committed','duplicate'))
    ORDER BY b.account_id`,
    [accountIds],
  );
  return rows.map((row) => Number(row.account_id));
}

/** Caller holds the batch, account, and portfolio write locks. */
export async function compareAndSetReconciledTransaction(
  before: PortfolioTransactionSnapshot,
  after: PortfolioTransactionSnapshot,
  expectedUpdatedAt: Date | string | null | undefined = undefined,
): Promise<PortfolioTransactionSnapshot | undefined> {
  const row = await queryOne(
    reconciliationSnapshotRowSchema,
    `UPDATE portfolio_transactions pt SET
       date = ($2::jsonb->>'date')::date,
       amount = ($2::jsonb->>'amount')::numeric,
       units = ($2::jsonb->>'units')::numeric,
       price_per_unit = ($2::jsonb->>'price_per_unit')::numeric,
       fees = ($2::jsonb->>'fees')::numeric,
       taxes = ($2::jsonb->>'taxes')::numeric,
       currency = $2::jsonb->>'currency',
       dividend_amount_convention = $2::jsonb->>'dividend_amount_convention',
       income_recognition_role = COALESCE($2::jsonb->>'income_recognition_role','standard'),
       fx_rate_to_eur = ($2::jsonb->>'fx_rate_to_eur')::numeric,
       account_id = ($2::jsonb->>'account_id')::integer,
       source_record_hash = $2::jsonb->>'source_record_hash',
       dedup_fingerprint = $2::jsonb->>'dedup_fingerprint',
       dedup_fingerprint_version = ($2::jsonb->>'dedup_fingerprint_version')::smallint
     WHERE pt.id = $1 AND ${SNAPSHOT} = normalize_portfolio_income_snapshot($3::jsonb)
       AND ($4::timestamptz IS NULL OR pt.updated_at = $4::timestamptz)
     RETURNING ${SNAPSHOT} AS snapshot`,
    [
      before.id,
      JSON.stringify(after),
      JSON.stringify(before),
      expectedUpdatedAt ?? null,
    ],
  );
  return row?.snapshot;
}

export async function insertReconciliationReceipt({
  batchId,
  stagingRowId,
  transactionId,
  action,
  policy,
  before,
  after,
  previousEntryId = undefined,
}: {
  batchId: Id;
  stagingRowId: Id;
  transactionId: number;
  action: ReconciliationJournalRow["action"];
  policy: ReconciliationJournalRow["policy"];
  before: PortfolioTransactionSnapshot;
  after: PortfolioTransactionSnapshot;
  previousEntryId?: Id | null;
}): Promise<number> {
  const result = await query(
    `INSERT INTO portfolio_import_reconciliation_journal
       (batch_id, staging_row_id, transaction_id, action, policy, before_data, after_data, previous_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) RETURNING id`,
    [
      batchId,
      stagingRowId,
      transactionId,
      action,
      policy,
      JSON.stringify(before),
      JSON.stringify(after),
      previousEntryId ?? null,
    ],
  );
  const [inserted] = checkRows(bigintIdRowSchema, result.rows);
  // INSERT ... RETURNING without ON CONFLICT yields exactly one row.
  return Number(inserted!.id);
}

export async function markAdoptedSourceDuplicate(
  stagingRowId: Id,
  batchId: Id,
): Promise<void> {
  await query(
    `UPDATE portfolio_import_staging_rows SET status = 'duplicate'
      WHERE id = $1 AND batch_id = $2 AND status = 'matched'`,
    [stagingRowId, batchId],
  );
  await query(
    `UPDATE portfolio_import_batches SET rows_duplicate = rows_duplicate + 1 WHERE id = $1`,
    [batchId],
  );
}

export async function markSaxoCompanionSourceDuplicate(
  row: Pick<ReconciliationSourceRow, "id" | "batch_id" | "status">,
): Promise<boolean> {
  const result = await query(
    `WITH previous AS (
       SELECT id,status FROM portfolio_import_staging_rows
        WHERE id=$1 AND batch_id=$2 AND status=$3 AND status IN ('matched','error')
     ), changed AS (
       UPDATE portfolio_import_staging_rows source SET status='duplicate',error_message=NULL
        FROM previous WHERE source.id=previous.id RETURNING previous.status
     ) UPDATE portfolio_import_batches SET rows_duplicate=rows_duplicate+(SELECT count(*) FROM changed),
       rows_error=rows_error-(SELECT count(*) FROM changed WHERE status='error')
       WHERE id=$2 AND EXISTS(SELECT 1 FROM changed) RETURNING id`,
    [row.id, row.batch_id, row.status],
  );
  return result.rows.length === 1;
}

export async function getActiveAdoptionReceipts(
  batchId: Id,
): Promise<ReconciliationJournalRow[]> {
  return queryRows(
    reconciliationJournalRowSchema,
    `SELECT a.* FROM portfolio_import_reconciliation_journal a
      WHERE a.batch_id = $1 AND a.action = 'adopt'
        AND NOT EXISTS (
          SELECT 1 FROM portfolio_import_reconciliation_journal r
           WHERE r.previous_entry_id = a.id
        ) ORDER BY a.id`,
    [batchId],
  );
}

export async function retainKinesisNativeGiftReceipt(
  row: ReconciliationSourceRow,
  receipt: unknown,
): Promise<boolean> {
  return (
    (
      await query(
        `UPDATE portfolio_import_staging_rows SET asset_transfer_details=jsonb_build_object('nativeGiftGroupReceipt',$2::jsonb)
    WHERE id=$1 AND route='portfolio' AND type='gift' AND status IN ('committed','duplicate') AND raw_data=$3 AND source_record_hash=$4 AND dedup_fingerprint=$5 AND asset_transfer_details::jsonb IS NOT DISTINCT FROM $6::jsonb RETURNING id`,
        [
          row.id,
          JSON.stringify(receipt),
          row.raw_data,
          row.source_record_hash,
          row.dedup_fingerprint,
          row.asset_transfer_details == null
            ? null
            : JSON.stringify(row.asset_transfer_details),
        ],
      )
    ).rows.length === 1
  );
}
