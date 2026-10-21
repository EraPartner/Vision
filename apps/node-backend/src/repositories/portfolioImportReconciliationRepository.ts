/** Explicit history reads, compare-and-set adoption, and immutable receipts. */
import { sql } from "kysely";
import type { ExpressionBuilder } from "kysely";
import type { AccountId, InvestmentId } from "@vision/types/brands";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { DB, Json } from "../database/schema.generated.ts";
import {
  batchAccountIdRowSchema,
  bigintIdRowSchema,
  crossFormatLedgerSourceRowSchema,
  ledgerFingerprintRowSchema,
  manualCashCandidateRowSchema,
  reconciliationAdjustmentRowSchema,
  reconciliationBatchScopeRowSchema,
  reconciliationJournalRowSchema,
  reconciliationSnapshotRowSchema,
  reconciliationSourceRowSchema,
  reconciliationTransferRowSchema,
} from "../database/rows/portfolioImport.ts";
import type {
  CrossFormatLedgerSourceRow,
  ManualCashCandidateRow,
  PortfolioTransactionSnapshot,
  ReconciliationBatchScopeRow,
  ReconciliationJournalRow,
  ReconciliationSourceRow,
} from "../database/rows/portfolioImport.ts";
import type { PortfolioAssetAdjustmentRow } from "./portfolioAssetAdjustmentRepository.ts";
import type { PortfolioAssetTransferRow } from "./portfolioAssetTransferRepository.ts";

export type {
  CrossFormatLedgerSourceRow,
  ManualCashCandidateRow,
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
const snapshot = sql.raw<PortfolioTransactionSnapshot>(
  PORTFOLIO_TRANSACTION_SNAPSHOT_SQL,
);
const jsonb = (value: unknown) => sql<Json>`${JSON.stringify(value)}::jsonb`;
const anyBigint = (ids: readonly Id[]) => sql<string>`ANY(${ids}::bigint[])`;
const anyInteger = <T>(ids: readonly number[]) =>
  sql<T>`ANY(${ids}::integer[])`;

/** Journal entry `a` has not been superseded by a later restore. */
function activeJournalEntry(
  eb: ExpressionBuilder<DB & { a: DB["portfolio_import_reconciliation_journal"] }, "a">,
) {
  return eb.not(
    eb.exists(
      eb
        .selectFrom("portfolio_import_reconciliation_journal as r")
        .select(sql`1`.as("one"))
        .whereRef("r.previous_entry_id", "=", "a.id"),
    ),
  );
}

export async function lockReconciliationAccountsAndHistory(
  accountIds: readonly number[],
): Promise<void> {
  if (accountIds.length > 0)
    await db
      .selectFrom("accounts")
      .select("id")
      .where("id", "=", anyInteger<AccountId>(accountIds))
      .orderBy("id")
      .forUpdate()
      .execute();
  await sql`LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments, transactions IN SHARE ROW EXCLUSIVE MODE`.execute(
    db,
  );
}

/** Formats whose history another format can also export (ADR-236 amendment). */
const CROSS_FORMATS = [
  "saxo_transaction_history",
  "ibkr_transaction_history",
  "ibkr_funding_history",
];

/**
 * Settled staging rows of other batches on these accounts whose ledger event
 * still exists: a portfolio or cash transaction carries the row's identity.
 * A rolled-back batch's rows drop out because their transactions are gone.
 */
export async function readCrossFormatLedgerSources(
  accountIds: readonly number[],
  excludedBatchIds: readonly Id[],
): Promise<CrossFormatLedgerSourceRow[]> {
  if (accountIds.length === 0) return [];
  return checkedRows(
    crossFormatLedgerSourceRowSchema,
    sql`SELECT s.id, s.batch_id, s.status, s.route, s.type::text AS type, s.type_raw,
        to_char(s.tx_date, 'YYYY-MM-DD') AS tx_date, s.units, s.amount, s.currency,
        s.raw_data, s.source_transaction_id, s.source_account_identity,
        s.dedup_fingerprint, s.dedup_fingerprint_version,
        COALESCE(s.user_override_investment_id, s.resolved_investment_id) AS investment_id,
        b.account_id, b.custom_config,
        CASE WHEN pt.id IS NOT NULL THEN 'portfolio' ELSE 'cash' END AS ledger,
        COALESCE(pt.id, t.id) AS transaction_id,
        to_char(t.date, 'YYYY-MM-DD') AS ledger_date,
        t.amount AS ledger_amount, t.currency AS ledger_currency
      FROM portfolio_import_staging_rows s
      JOIN portfolio_import_batches b ON b.id = s.batch_id
      LEFT JOIN LATERAL (
        SELECT p.id FROM portfolio_transactions p
         WHERE s.route IS DISTINCT FROM 'cash'
           AND p.dedup_fingerprint = s.dedup_fingerprint
           AND p.dedup_fingerprint_version = s.dedup_fingerprint_version
         ORDER BY p.id LIMIT 1) pt ON true
      LEFT JOIN LATERAL (
        SELECT c.id, c.date, c.amount, c.currency FROM transactions c
         WHERE s.route = 'cash' AND c.account_id = b.account_id AND c.is_active
           AND c.dedup_fingerprint = s.dedup_fingerprint
           AND c.dedup_fingerprint_version = s.dedup_fingerprint_version
         ORDER BY c.id LIMIT 1) t ON true
     WHERE b.account_id = ANY(${accountIds}::integer[])
       AND NOT (b.id = ANY(${excludedBatchIds}::bigint[]))
       AND b.custom_config->>'format' = ANY(${CROSS_FORMATS}::text[])
       AND s.status IN ('committed', 'duplicate')
       AND s.dedup_fingerprint IS NOT NULL
       AND (pt.id IS NOT NULL OR t.id IS NOT NULL)
     ORDER BY s.batch_id, s.row_index, s.id`,
  );
}

/** The identities among `fingerprints` that an active cash transaction carries. */
export async function readCashLedgerFingerprints(
  fingerprints: readonly string[],
): Promise<Set<string>> {
  if (fingerprints.length === 0) return new Set();
  const rows = await checkedRows(
    ledgerFingerprintRowSchema,
    sql`SELECT DISTINCT dedup_fingerprint, dedup_fingerprint_version FROM transactions
     WHERE dedup_fingerprint = ANY(${[...new Set(fingerprints)]}::text[])`,
  );
  return new Set(
    rows.map(
      (row) => `${row.dedup_fingerprint_version}:${row.dedup_fingerprint}`,
    ),
  );
}

/**
 * Active cash transactions on these accounts that no import owns: no import
 * identity or source hash. A brokerage import may adopt one as its record.
 */
export async function readManualCashCandidates(
  accountIds: readonly number[],
  from: string,
  to: string,
): Promise<ManualCashCandidateRow[]> {
  if (accountIds.length === 0) return [];
  return checkedRows(
    manualCashCandidateRowSchema,
    sql`SELECT id, account_id, to_char(date, 'YYYY-MM-DD') AS date, amount, currency
      FROM transactions
     WHERE account_id = ANY(${accountIds}::integer[]) AND is_active
       AND dedup_fingerprint IS NULL AND source_record_hash IS NULL
       AND date BETWEEN ${from}::date AND ${to}::date
     ORDER BY date, id`,
  );
}

/**
 * Settle a staged row that another format's record already holds. An
 * unsupported-event row (status error) is cleared from the error count.
 * @returns false when the row changed since it was planned
 */
export async function markCrossFormatSourceDuplicate(
  row: Pick<ReconciliationSourceRow, "id" | "batch_id" | "status">,
): Promise<boolean> {
  const result = await sql`WITH previous AS (
       SELECT id, status FROM portfolio_import_staging_rows
        WHERE id = ${row.id} AND batch_id = ${row.batch_id} AND status = ${row.status}
          AND status IN ('matched', 'error')
     ), changed AS (
       UPDATE portfolio_import_staging_rows source SET status = 'duplicate', error_message = NULL
         FROM previous WHERE source.id = previous.id RETURNING previous.status
     ) UPDATE portfolio_import_batches
          SET rows_duplicate = rows_duplicate + (SELECT count(*) FROM changed),
              rows_error = GREATEST(rows_error - (SELECT count(*) FROM changed WHERE status = 'error'), 0)
        WHERE id = ${row.batch_id} AND EXISTS (SELECT 1 FROM changed) RETURNING id`.execute(
    db,
  );
  return result.rows.length === 1;
}

export async function readReconciliationSources(
  batchIds: readonly Id[],
): Promise<ReconciliationSourceRow[]> {
  const investmentId = sql<InvestmentId | null>`COALESCE(s.user_override_investment_id, s.resolved_investment_id)`;
  return checkedRows(
    reconciliationSourceRowSchema,
    db
      .selectFrom("portfolio_import_staging_rows as s")
      .innerJoin("portfolio_import_batches as b", "b.id", "s.batch_id")
      .leftJoin("investments as i", (join) =>
        join.on(sql<boolean>`i.id = ${investmentId}`),
      )
      .selectAll("s")
      .select([
        sql<string | null>`to_char(s.tx_date, 'YYYY-MM-DD')`.as("tx_date"),
        investmentId.as("investment_id"),
        "i.asset_class",
        "i.currency as investment_currency",
        "b.account_id",
        "b.custom_config",
        "b.adapter_name",
        "b.status as batch_status",
      ])
      .where("s.batch_id", "=", anyBigint(batchIds))
      .orderBy("s.batch_id")
      .orderBy("s.row_index")
      .orderBy("s.id"),
  );
}

export async function readReconciliationHistory(
  investmentIds: readonly number[],
): Promise<ReconciliationHistoryEvent[]> {
  if (investmentIds.length === 0) return [];
  const investments = anyInteger<InvestmentId>(investmentIds);
  const rows = await checkedRows(
    reconciliationSnapshotRowSchema,
    db
      .selectFrom("portfolio_transactions as pt")
      .select(snapshot.as("snapshot"))
      .where("pt.investment_id", "=", investments)
      .orderBy("pt.investment_id")
      .orderBy("pt.date")
      .orderBy("pt.id"),
  );
  const transfers = await checkedRows(
    reconciliationTransferRowSchema,
    db
      .selectFrom("portfolio_asset_transfers as t")
      .selectAll("t")
      .select(sql<string>`to_char(t.date, 'YYYY-MM-DD')`.as("date"))
      .where("t.investment_id", "=", investments)
      .orderBy("t.investment_id")
      .orderBy("t.date")
      .orderBy("t.id"),
  );
  const adjustments = await checkedRows(
    reconciliationAdjustmentRowSchema,
    db
      .selectFrom("portfolio_asset_adjustments as a")
      .selectAll("a")
      .select(sql<string>`to_char(a.date,'YYYY-MM-DD')`.as("date"))
      .where("a.investment_id", "=", investments)
      .orderBy("a.investment_id")
      .orderBy("a.date")
      .orderBy("a.id"),
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
  return checkedRows(
    reconciliationBatchScopeRowSchema,
    db
      .selectFrom("portfolio_import_batches")
      .select([
        "id",
        "account_id",
        "status",
        "custom_config",
        "adapter_name",
        "rows_total",
      ])
      .where("id", "=", anyBigint(batchIds))
      .orderBy("id"),
  );
}

export async function readReconciledProImportAccounts(
  accountIds: readonly number[],
): Promise<number[]> {
  if (accountIds.length === 0) return [];
  const rows = await checkedRows(
    batchAccountIdRowSchema,
    sql`SELECT DISTINCT b.account_id FROM portfolio_import_batches b
    WHERE b.account_id = ANY(${accountIds}::integer[]) AND b.status = 'complete'
      AND (b.adapter_name = 'nexo_pro_spot_history' OR b.custom_config->>'format' = 'nexo_pro_spot_history')
      AND EXISTS (SELECT 1 FROM portfolio_import_staging_rows s WHERE s.batch_id = b.id
        AND s.route = 'portfolio' AND s.type IN ('buy','sell') AND s.status IN ('committed','duplicate'))
    ORDER BY b.account_id`,
  );
  return rows.map((row) => Number(row.account_id));
}

/** Caller holds the batch, account, and portfolio write locks. */
export async function compareAndSetReconciledTransaction(
  before: PortfolioTransactionSnapshot,
  after: PortfolioTransactionSnapshot,
  expectedUpdatedAt: Date | string | null | undefined = undefined,
): Promise<PortfolioTransactionSnapshot | undefined> {
  const image = jsonb(after);
  const updatedAt = expectedUpdatedAt ?? null;
  const row = await checkedRow(
    reconciliationSnapshotRowSchema,
    sql`UPDATE portfolio_transactions pt SET
       date = (${image}->>'date')::date,
       amount = (${image}->>'amount')::numeric,
       units = (${image}->>'units')::numeric,
       price_per_unit = (${image}->>'price_per_unit')::numeric,
       fees = (${image}->>'fees')::numeric,
       taxes = (${image}->>'taxes')::numeric,
       currency = ${image}->>'currency',
       dividend_amount_convention = ${image}->>'dividend_amount_convention',
       income_recognition_role = COALESCE(${image}->>'income_recognition_role','standard'),
       fx_rate_to_eur = (${image}->>'fx_rate_to_eur')::numeric,
       account_id = (${image}->>'account_id')::integer,
       source_record_hash = ${image}->>'source_record_hash',
       dedup_fingerprint = ${image}->>'dedup_fingerprint',
       dedup_fingerprint_version = (${image}->>'dedup_fingerprint_version')::smallint
     WHERE pt.id = ${before.id} AND ${snapshot} = normalize_portfolio_income_snapshot(${jsonb(before)})
       AND (${updatedAt}::timestamptz IS NULL OR pt.updated_at = ${updatedAt}::timestamptz)
     RETURNING ${snapshot} AS snapshot`,
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
  const [inserted] = await checkedRows(
    bigintIdRowSchema,
    db
      .insertInto("portfolio_import_reconciliation_journal")
      .values({
        batch_id: batchId,
        staging_row_id: stagingRowId,
        transaction_id: transactionId,
        action,
        policy,
        before_data: jsonb(before),
        after_data: jsonb(after),
        previous_entry_id: previousEntryId ?? null,
      })
      .returning("id"),
  );
  // INSERT ... RETURNING without ON CONFLICT yields exactly one row.
  return Number(inserted!.id);
}

export async function markAdoptedSourceDuplicate(
  stagingRowId: Id,
  batchId: Id,
): Promise<void> {
  await db
    .updateTable("portfolio_import_staging_rows")
    .set({ status: "duplicate" })
    .where("id", "=", String(stagingRowId))
    .where("batch_id", "=", String(batchId))
    .where("status", "=", "matched")
    .execute();
  await db
    .updateTable("portfolio_import_batches")
    .set((eb) => ({ rows_duplicate: eb("rows_duplicate", "+", 1) }))
    .where("id", "=", String(batchId))
    .execute();
}

export async function getActiveAdoptionReceipts(
  batchId: Id,
): Promise<ReconciliationJournalRow[]> {
  return checkedRows(
    reconciliationJournalRowSchema,
    db
      .selectFrom("portfolio_import_reconciliation_journal as a")
      .selectAll("a")
      .where("a.batch_id", "=", String(batchId))
      .where("a.action", "=", "adopt")
      .where(activeJournalEntry)
      .orderBy("a.id"),
  );
}
