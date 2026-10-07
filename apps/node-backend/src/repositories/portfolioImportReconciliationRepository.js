/** Explicit history reads, compare-and-set adoption, and immutable receipts. */
import { query } from "../database/connection.ts";

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

export async function lockReconciliationAccountsAndHistory(accountIds) {
  if (accountIds.length > 0)
    await query(
      "SELECT id FROM accounts WHERE id = ANY($1::integer[]) ORDER BY id FOR UPDATE",
      [accountIds],
    );
  await query(
    "LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE",
  );
}

export async function readReconciliationSources(batchIds) {
  const { rows } = await query(
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

export async function readReconciliationHistory(investmentIds) {
  if (investmentIds.length === 0) return [];
  const { rows } = await query(
    `SELECT ${SNAPSHOT} AS snapshot
       FROM portfolio_transactions pt
      WHERE pt.investment_id = ANY($1::int[])
      ORDER BY pt.investment_id, pt.date, pt.id`,
    [investmentIds],
  );
  const transfers = (
    await query(
      `SELECT t.*, to_char(t.date, 'YYYY-MM-DD') AS date
    FROM portfolio_asset_transfers t WHERE t.investment_id = ANY($1::integer[]) ORDER BY t.investment_id, t.date, t.id`,
      [investmentIds],
    )
  ).rows;
  const adjustments = (
    await query(
      "SELECT a.*,to_char(a.date,'YYYY-MM-DD') AS date FROM portfolio_asset_adjustments a WHERE investment_id=ANY($1::integer[]) ORDER BY a.investment_id,a.date,a.id",
      [investmentIds],
    )
  ).rows;
  return [
    ...rows.map((row) => row.snapshot),
    ...transfers.map((row) => ({
      ...row,
      id: Number(row.id),
      transfer_id: Number(row.id),
      type: "asset_transfer",
      amount: "0",
      fees: "0",
      taxes: "0",
    })),
    ...adjustments.map((row) => ({
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

export async function readReconciliationBatchScope(batchIds) {
  const { rows } = await query(
    `SELECT id, account_id, status, custom_config, adapter_name
       FROM portfolio_import_batches
      WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [batchIds],
  );
  return rows;
}

export async function readReconciledProImportAccounts(accountIds) {
  if (accountIds.length === 0) return [];
  const { rows } = await query(
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
  before,
  after,
  expectedUpdatedAt = undefined,
) {
  const { rows } = await query(
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
}) {
  const { rows } = await query(
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

export async function markAdoptedSourceDuplicate(stagingRowId, batchId) {
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

export async function getActiveAdoptionReceipts(batchId) {
  const { rows } = await query(
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
