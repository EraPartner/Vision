/** Explicit history reads, compare-and-set adoption, and immutable receipts. */
import { requireRow } from "../database/rowContracts.ts";
import { sql } from "kysely";
import type { ExpressionBuilder } from "kysely";
import type { InvestmentId } from "@vision/types/brands";
import {
  __getAmbientTransactionClient,
  withTransaction,
} from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { DB } from "../database/schema.generated.ts";
import { portfolioIncomeTransactionSnapshotSql } from "../database/sqlite/schemaFunctions.ts";
import {
  batchAccountIdRowSchema,
  bigintIdRowSchema,
  crossFormatLedgerSourceRowSchema,
  historySourceIdRowSchema,
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
  HistorySourceIdRow,
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
// The canonical jsonb text of portfolio transaction `pt` (schemaFunctions.ts);
// read it with a `::json` alias hint.
export const PORTFOLIO_TRANSACTION_SNAPSHOT_SQL =
  portfolioIncomeTransactionSnapshotSql("pt");
const snapshot = sql.raw<PortfolioTransactionSnapshot>(
  PORTFOLIO_TRANSACTION_SNAPSHOT_SQL,
);
/** A JSON array parameter for `IN (SELECT value FROM json_each(?))`. */
const inJson = <T = number>(values: readonly unknown[]) =>
  sql<T>`(SELECT value FROM json_each(${JSON.stringify(values)}))`;
const inIds = <T = number>(ids: readonly Id[]) => inJson<T>(ids.map(Number));

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

/**
 * Hold the accounts and the portfolio, custody and cash ledgers for a
 * reconciliation. PostgreSQL locked the account rows and the four tables; the
 * caller's withTransaction() (BEGIN IMMEDIATE on the single SQLite writer)
 * now excludes every other write until it ends (ADR-263). Refuses to run
 * outside a transaction, where nothing would hold.
 */
export function lockReconciliationAccountsAndHistory(
  _accountIds: readonly number[],
): Promise<void> {
  if (!__getAmbientTransactionClient())
    return Promise.reject(
      new Error(
        "lockReconciliationAccountsAndHistory must run inside withTransaction()",
      ),
    );
  return Promise.resolve();
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
    // The first matching ledger row of each kind, as PostgreSQL's
    // LEFT JOIN LATERAL (... ORDER BY id LIMIT 1) chose it.
    sql`SELECT s.id, s.batch_id, s.status, s.route, s.type AS type, s.type_raw,
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
      LEFT JOIN portfolio_transactions pt ON pt.id = (
        SELECT p.id FROM portfolio_transactions p
         WHERE s.route IS NOT 'cash'
           AND p.dedup_fingerprint = s.dedup_fingerprint
           AND p.dedup_fingerprint_version = s.dedup_fingerprint_version
         ORDER BY p.id LIMIT 1)
      LEFT JOIN transactions t ON t.id = (
        SELECT c.id FROM transactions c
         WHERE s.route = 'cash' AND c.account_id = b.account_id AND c.is_active
           AND c.dedup_fingerprint = s.dedup_fingerprint
           AND c.dedup_fingerprint_version = s.dedup_fingerprint_version
         ORDER BY c.id LIMIT 1)
     WHERE b.account_id IN ${inIds(accountIds)}
       AND b.id NOT IN ${inIds(excludedBatchIds)}
       AND b.custom_config ->> 'format' IN ${inJson(CROSS_FORMATS)}
       AND s.status IN ('committed', 'duplicate')
       AND s.dedup_fingerprint IS NOT NULL
       AND (pt.id IS NOT NULL OR t.id IS NOT NULL)
     ORDER BY s.batch_id, s.row_index, s.id`,
  );
}

/**
 * `version:fingerprint` identities of rows that an earlier review settled as
 * recorded by another export: duplicate staging rows of the cross-format
 * batches whose identity no ledger transaction carries. A repeat of such a
 * row keeps the owner's earlier pairing choice.
 */
export async function readCrossFormatSettledIdentities(
  accountIds: readonly number[],
  excludedBatchIds: readonly Id[],
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const rows = await checkedRows(
    ledgerFingerprintRowSchema,
    sql`SELECT DISTINCT s.dedup_fingerprint, s.dedup_fingerprint_version
      FROM portfolio_import_staging_rows s
      JOIN portfolio_import_batches b ON b.id = s.batch_id
     WHERE b.account_id IN ${inIds(accountIds)}
       AND b.id NOT IN ${inIds(excludedBatchIds)}
       AND b.custom_config ->> 'format' IN ${inJson(CROSS_FORMATS)}
       AND s.status = 'duplicate'
       AND s.dedup_fingerprint IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM portfolio_transactions p
          WHERE p.dedup_fingerprint = s.dedup_fingerprint
            AND p.dedup_fingerprint_version = s.dedup_fingerprint_version)
       AND NOT EXISTS (SELECT 1 FROM transactions c
          WHERE c.is_active AND c.account_id = b.account_id
            AND c.dedup_fingerprint = s.dedup_fingerprint
            AND c.dedup_fingerprint_version = s.dedup_fingerprint_version)`,
  );
  return new Set(
    rows.map(
      (row) => `${row.dedup_fingerprint_version}:${row.dedup_fingerprint}`,
    ),
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
     WHERE dedup_fingerprint IN ${inJson([...new Set(fingerprints)])}`,
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
     WHERE account_id IN ${inIds(accountIds)} AND is_active
       AND dedup_fingerprint IS NULL AND source_record_hash IS NULL
       AND date BETWEEN ${from} AND ${to}
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
  // One unit, as PostgreSQL's single data-modifying statement was. The WHERE
  // pins the previous status, so the counters move by what it was.
  return withTransaction(async () => {
    const changed = await db
      .updateTable("portfolio_import_staging_rows")
      .set({ status: "duplicate", error_message: null })
      .where("id", "=", row.id)
      .where("batch_id", "=", row.batch_id)
      .where("status", "=", row.status)
      .where("status", "in", ["matched", "error"])
      .executeTakeFirst();
    const count = Number(changed.numUpdatedRows);
    if (count === 0) return false;
    const errorCount = row.status === "error" ? count : 0;
    const result = await db
      .updateTable("portfolio_import_batches")
      .set({
        rows_duplicate: sql<number>`rows_duplicate + ${count}`,
        rows_error: sql<number>`max(rows_error - ${errorCount}, 0)`,
      })
      .where("id", "=", row.batch_id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  });
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
      .where("s.batch_id", "in", inIds<string>(batchIds))
      .orderBy("s.batch_id")
      .orderBy("s.row_index")
      .orderBy("s.id"),
  );
}

export async function readReconciliationHistory(
  investmentIds: readonly number[],
): Promise<ReconciliationHistoryEvent[]> {
  if (investmentIds.length === 0) return [];
  const investments = inIds<InvestmentId>(investmentIds);
  const rows = await checkedRows(
    reconciliationSnapshotRowSchema,
    sql`SELECT ${snapshot} AS "snapshot::json"
          FROM portfolio_transactions pt
         WHERE pt.investment_id IN ${investments}
         ORDER BY pt.investment_id, pt.date, pt.id`,
  );
  const transfers = await checkedRows(
    reconciliationTransferRowSchema,
    db
      .selectFrom("portfolio_asset_transfers as t")
      .selectAll("t")
      .select(sql<string>`to_char(t.date, 'YYYY-MM-DD')`.as("date"))
      .where("t.investment_id", "in", investments)
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
      .where("a.investment_id", "in", investments)
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

/**
 * The immutable source ids each imported transaction was recorded from: every
 * settled staging row that carries its identity, with that batch's
 * specialized export format. Generic CSV batches name no export format, and
 * transactions recorded without a source id are absent.
 */
export async function readHistorySourceIds(
  transactionIds: readonly number[],
): Promise<HistorySourceIdRow[]> {
  if (transactionIds.length === 0) return [];
  return checkedRows(
    historySourceIdRowSchema,
    sql`SELECT DISTINCT pt.id, s.source_transaction_id,
        b.custom_config ->> 'format' AS format
      FROM portfolio_transactions pt
      JOIN portfolio_import_staging_rows s
        ON s.dedup_fingerprint = pt.dedup_fingerprint
       AND s.dedup_fingerprint_version = pt.dedup_fingerprint_version
       AND s.status IN ('committed', 'duplicate')
      JOIN portfolio_import_batches b ON b.id = s.batch_id
     WHERE pt.id IN ${inIds(transactionIds)}
       AND pt.dedup_fingerprint IS NOT NULL
       AND NULLIF(trim(s.source_transaction_id), '') IS NOT NULL
       AND NULLIF(b.custom_config ->> 'format', '') IS NOT NULL
     ORDER BY pt.id, format, s.source_transaction_id`,
  );
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
      .where("id", "in", inIds<string>(batchIds))
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
    WHERE b.account_id IN ${inIds(accountIds)} AND b.status = 'complete'
      AND (b.adapter_name = 'nexo_pro_spot_history' OR b.custom_config ->> 'format' = 'nexo_pro_spot_history')
      AND EXISTS (SELECT 1 FROM portfolio_import_staging_rows s WHERE s.batch_id = b.id
        AND s.route = 'portfolio' AND s.type IN ('buy','sell') AND s.status IN ('committed','duplicate'))
    ORDER BY b.account_id`,
  );
  return rows.map((row) => row.account_id);
}

/** The current snapshot of one portfolio transaction, or undefined. */
async function readTransactionSnapshot(
  id: number,
): Promise<PortfolioTransactionSnapshot | undefined> {
  const row = await checkedRow(
    reconciliationSnapshotRowSchema,
    sql`SELECT ${snapshot} AS "snapshot::json" FROM portfolio_transactions pt WHERE pt.id = ${id}`,
  );
  return row?.snapshot;
}

/**
 * Write `after` over the transaction only while it still equals `before`
 * (and, when given, still carries `expectedUpdatedAt`). The caller's writer
 * transaction holds the batch, account and portfolio history.
 */
export async function compareAndSetReconciledTransaction(
  before: PortfolioTransactionSnapshot,
  after: PortfolioTransactionSnapshot,
  expectedUpdatedAt?: Date | string | null,
): Promise<PortfolioTransactionSnapshot | undefined> {
  const image = JSON.stringify(after);
  const field = (key: string) => sql`${image} ->> ${key}`;
  const updatedAt = expectedUpdatedAt ?? null;
  // A savepoint keeps the write and its read-back one unit.
  return withTransaction(async () => {
    // SQLite 3.39 has no UPDATE target alias: the snapshot names the table.
    const current = sql.raw(
      portfolioIncomeTransactionSnapshotSql("portfolio_transactions"),
    );
    const result = await sql`UPDATE portfolio_transactions SET
       date = ${field("date")},
       amount = vision_numeric(${field("amount")}, 18, 4),
       units = vision_numeric(${field("units")}, 18, 8),
       price_per_unit = vision_numeric(${field("price_per_unit")}, 18, 6),
       fees = vision_numeric(${field("fees")}, 18, 4),
       taxes = vision_numeric(${field("taxes")}, 18, 4),
       currency = ${field("currency")},
       dividend_amount_convention = ${field("dividend_amount_convention")},
       income_recognition_role = COALESCE(${field("income_recognition_role")}, 'standard'),
       fx_rate_to_eur = vision_numeric(${field("fx_rate_to_eur")}, 20, 10),
       account_id = CAST(${field("account_id")} AS INTEGER),
       source_record_hash = ${field("source_record_hash")},
       dedup_fingerprint = ${field("dedup_fingerprint")},
       dedup_fingerprint_version = CAST(${field("dedup_fingerprint_version")} AS INTEGER),
       updated_at = now()
     WHERE portfolio_transactions.id = ${before.id}
       AND ${current} = normalize_portfolio_income_snapshot(${JSON.stringify(before)})
       AND (${updatedAt} IS NULL OR portfolio_transactions.updated_at = vision_ts(${updatedAt}))`.execute(
      db,
    );
    if (Number(result.numAffectedRows ?? 0) !== 1) return undefined;
    return readTransactionSnapshot(Number(before.id));
  });
}

export async function insertReconciliationReceipt({
  batchId,
  stagingRowId,
  transactionId,
  action,
  policy,
  before,
  after,
  previousEntryId,
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
        before_data: JSON.stringify(before),
        after_data: JSON.stringify(after),
        previous_entry_id: previousEntryId ?? null,
      })
      .returning("id"),
  );
  // INSERT ... RETURNING without ON CONFLICT yields exactly one row.
  return Number(requireRow(inserted, "reconciliation receipt insert").id);
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
