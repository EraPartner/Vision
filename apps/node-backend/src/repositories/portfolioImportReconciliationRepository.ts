/** Explicit history reads, compare-and-set adoption, and immutable receipts. */
import { query } from "../database/connection.ts";
import type { PortfolioImportStagingRow } from "../types/rows.ts";
import type { PortfolioAssetAdjustmentRow } from "./portfolioAssetAdjustmentRepository.ts";
import type { PortfolioAssetTransferRow } from "./portfolioAssetTransferRepository.ts";

type Id = number | string;

/**
 * The receipt shape of a portfolio transaction (see
 * PORTFOLIO_TRANSACTION_SNAPSHOT_SQL): NUMERIC columns as exact text.
 */
export type PortfolioTransactionSnapshot = {
  id: number;
  investment_id: number;
  type: string;
  /** 'YYYY-MM-DD' */
  date: string;
  amount: string | null;
  units: string | null;
  price_per_unit: string | null;
  fees: string | null;
  taxes: string | null;
  currency: string | null;
  fx_rate_to_eur: string | null;
  account_id: number | null;
  note: string | null;
  dividend_amount_convention: string;
  is_recurring: boolean;
  recurrence_interval: string | null;
  /** 'YYYY-MM-DD' */
  recurrence_end_date: string | null;
  import_batch_id: string | null;
  source_record_hash: string | null;
  dedup_fingerprint: string | null;
  dedup_fingerprint_version: number | null;
};

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

/*
 * The JSON detail and batch-config columns hold adapter-specific shapes that
 * the import services read dynamically, so they stay untyped here (as
 * PortfolioImportBatchRow.custom_config does).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
/** A staged row joined to its investment and batch. */
export type ReconciliationSourceRow = Omit<
  PortfolioImportStagingRow,
  "tx_date" | "route"
> & {
  /** 'YYYY-MM-DD' */
  tx_date: string | null;
  route: string | null;
  asset_transfer_details: any;
  asset_adjustment_details: any;
  investment_id: number | null;
  asset_class: string | null;
  investment_currency: string | null;
  account_id: number | null;
  custom_config: any;
  adapter_name: string;
  batch_status: string;
};

export type ReconciliationBatchScopeRow = {
  id: string;
  account_id: number | null;
  status: string;
  custom_config: any;
  adapter_name: string;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ReconciliationJournalRow = {
  id: string;
  batch_id: string;
  staging_row_id: string;
  transaction_id: number;
  action: "adopt" | "restore";
  policy: "exact" | "preserve_existing" | "prefer_source";
  previous_entry_id: string | null;
  before_data: PortfolioTransactionSnapshot;
  after_data: PortfolioTransactionSnapshot;
  created_at: Date;
};

// Numeric strings preserve the database's exact stored precision in receipts.
export const PORTFOLIO_TRANSACTION_SNAPSHOT_SQL = `jsonb_build_object(
  'id', pt.id, 'investment_id', pt.investment_id, 'type', pt.type,
  'date', to_char(pt.date, 'YYYY-MM-DD'), 'amount', pt.amount::text,
  'units', pt.units::text, 'price_per_unit', pt.price_per_unit::text,
  'fees', pt.fees::text, 'taxes', pt.taxes::text, 'currency', pt.currency,
  'fx_rate_to_eur', pt.fx_rate_to_eur::text, 'account_id', pt.account_id,
  'note', pt.note, 'dividend_amount_convention', pt.dividend_amount_convention,
  'is_recurring', pt.is_recurring, 'recurrence_interval', pt.recurrence_interval,
  'recurrence_end_date', to_char(pt.recurrence_end_date, 'YYYY-MM-DD'),
  'import_batch_id', pt.import_batch_id::text,
  'source_record_hash', pt.source_record_hash,
  'dedup_fingerprint', pt.dedup_fingerprint,
  'dedup_fingerprint_version', pt.dedup_fingerprint_version)`;
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
  const { rows } = await query<ReconciliationSourceRow>(
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
  return rows;
}

export async function readReconciliationHistory(
  investmentIds: readonly number[],
): Promise<ReconciliationHistoryEvent[]> {
  if (investmentIds.length === 0) return [];
  const { rows } = await query<{ snapshot: PortfolioTransactionSnapshot }>(
    `SELECT ${SNAPSHOT} AS snapshot
       FROM portfolio_transactions pt
      WHERE pt.investment_id = ANY($1::int[])
      ORDER BY pt.investment_id, pt.date, pt.id`,
    [investmentIds],
  );
  const transfers = (
    await query<PortfolioAssetTransferRow>(
      `SELECT t.*, to_char(t.date, 'YYYY-MM-DD') AS date
    FROM portfolio_asset_transfers t WHERE t.investment_id = ANY($1::integer[]) ORDER BY t.investment_id, t.date, t.id`,
      [investmentIds],
    )
  ).rows;
  const adjustments = (
    await query<PortfolioAssetAdjustmentRow>(
      "SELECT a.*,to_char(a.date,'YYYY-MM-DD') AS date FROM portfolio_asset_adjustments a WHERE investment_id=ANY($1::integer[]) ORDER BY a.investment_id,a.date,a.id",
      [investmentIds],
    )
  ).rows;
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
  const { rows } = await query<ReconciliationBatchScopeRow>(
    `SELECT id, account_id, status, custom_config, adapter_name
       FROM portfolio_import_batches
      WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [batchIds],
  );
  return rows;
}

export async function readReconciledProImportAccounts(
  accountIds: readonly number[],
): Promise<number[]> {
  if (accountIds.length === 0) return [];
  const { rows } = await query<{ account_id: number }>(
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
  const { rows } = await query<{ snapshot: PortfolioTransactionSnapshot }>(
    `UPDATE portfolio_transactions pt SET
       date = ($2::jsonb->>'date')::date,
       amount = ($2::jsonb->>'amount')::numeric,
       units = ($2::jsonb->>'units')::numeric,
       price_per_unit = ($2::jsonb->>'price_per_unit')::numeric,
       fees = ($2::jsonb->>'fees')::numeric,
       taxes = ($2::jsonb->>'taxes')::numeric,
       currency = $2::jsonb->>'currency',
       dividend_amount_convention = $2::jsonb->>'dividend_amount_convention',
       fx_rate_to_eur = ($2::jsonb->>'fx_rate_to_eur')::numeric,
       account_id = ($2::jsonb->>'account_id')::integer,
       source_record_hash = $2::jsonb->>'source_record_hash',
       dedup_fingerprint = $2::jsonb->>'dedup_fingerprint',
       dedup_fingerprint_version = ($2::jsonb->>'dedup_fingerprint_version')::smallint
     WHERE pt.id = $1 AND ${SNAPSHOT} = $3::jsonb
       AND ($4::timestamptz IS NULL OR pt.updated_at = $4::timestamptz)
     RETURNING ${SNAPSHOT} AS snapshot`,
    [
      before.id,
      JSON.stringify(after),
      JSON.stringify(before),
      expectedUpdatedAt ?? null,
    ],
  );
  return rows[0]?.snapshot;
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
  const { rows } = await query<{ id: string }>(
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
  return Number(rows[0].id);
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

export async function getActiveAdoptionReceipts(
  batchId: Id,
): Promise<ReconciliationJournalRow[]> {
  const { rows } = await query<ReconciliationJournalRow>(
    `SELECT a.* FROM portfolio_import_reconciliation_journal a
      WHERE a.batch_id = $1 AND a.action = 'adopt'
        AND NOT EXISTS (
          SELECT 1 FROM portfolio_import_reconciliation_journal r
           WHERE r.previous_entry_id = a.id
        ) ORDER BY a.id`,
    [batchId],
  );
  return rows;
}
