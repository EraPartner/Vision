/** Explicit history reads, compare-and-set adoption, and immutable receipts. */
import { sql } from "kysely";
import type { ExpressionBuilder } from "kysely";
import type { AccountId, InvestmentId } from "@vision/types/brands";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { DB, Json } from "../database/schema.generated.ts";
import {
  batchAccountIdRowSchema,
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
  await sql`LOCK TABLE portfolio_transactions, portfolio_asset_transfers, portfolio_asset_adjustments IN SHARE ROW EXCLUSIVE MODE`.execute(
    db,
  );
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
