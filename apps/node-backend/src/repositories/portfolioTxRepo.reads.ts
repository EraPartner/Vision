/**
 * Portfolio transaction repo — read operations (list, count, getById, summary).
 */

import { sql } from "kysely";
import type { SelectQueryBuilder } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { DB } from "../database/schema.generated.ts";
import { countRowSchema } from "../database/rowSchemas.ts";
import {
  accountLabelRowSchema,
  assetClassRowSchema,
  portfolioMathTxRowSchema,
  portfolioTransactionCountedRowSchema,
  portfolioTransactionDbRowSchema,
  portfolioTransactionIdPairRowSchema,
  portfolioTransactionSummaryDbRowSchema,
  portfolioUnitEventRowSchema,
} from "../database/rows/portfolio.ts";
import type { PortfolioUnitEventDbRow } from "../database/rows/portfolio.ts";
import { coerceNumericFields } from "../lib/money.ts";
import { toYmd } from "../lib/dateFormat.ts";
import { validateId } from "../lib/validation.ts";
import { hasPortfolioTransactionImportBatchIdColumn } from "./portfolioTxRepo.common.ts";

import { asInvestmentId } from "@vision/types/brands";
import type {
  AccountId,
  InvestmentId,
  PortfolioTransactionId,
} from "@vision/types/brands";
import type {
  PortfolioMathTxRow,
  PortfolioTransactionRow,
  PortfolioTransactionSummaryRow,
} from "../types/rows.ts";
import { nanToZero, nonZeroOr } from "../lib/math.ts";

export type { PortfolioTransactionRow, PortfolioTransactionSummaryRow };

/**
 * One custody-relevant unit event: a portfolio transaction, asset transfer or
 * asset adjustment. The UNION widens ids to BIGINT and the numeric columns to
 * NUMERIC, so pg emits them as strings. Derived from the checked row schema.
 */
export type PortfolioUnitEventRow = PortfolioUnitEventDbRow;

export async function getAssetClassByInvestmentId(
  investmentId: InvestmentId,
): Promise<string | undefined> {
  const row = await checkedRow(
    assetClassRowSchema,
    db.selectFrom("investments").select("asset_class").where("id", "=", investmentId),
  );
  return row?.asset_class;
}

export async function getUnitEventsForInvestment(
  investmentId: InvestmentId,
): Promise<PortfolioUnitEventRow[]> {
  return checkedRows(
    portfolioUnitEventRowSchema,
    sql`
    SELECT id, type::text AS type, to_char(date, 'YYYY-MM-DD') AS date,
           COALESCE(units, 0) AS units, account_id, amount, fees, taxes,
           CASE WHEN COALESCE(currency,'EUR')='EUR' THEN 1 ELSE COALESCE(fx_rate_to_eur,
             (SELECT er.rate_to_eur FROM exchange_rates er WHERE er.currency_code=portfolio_transactions.currency AND er.rate_date<=portfolio_transactions.date ORDER BY er.rate_date DESC LIMIT 1)) END AS "fxMultiplier", NULL::int AS source_account_id,
           NULL::int AS destination_account_id, 0 AS fee_units, NULL::bigint AS transfer_id, currency,
           source_record_hash, NULL::text AS adjustment_kind, NULL::text AS basis_policy,
           NULL::text[] AS eligible_source_record_hashes, NULL::bigint AS adjustment_id, income_recognition_role
    FROM portfolio_transactions WHERE investment_id = ${investmentId}
    UNION ALL
    SELECT id, 'asset_transfer', to_char(date,'YYYY-MM-DD'), units, NULL::int,
           0,0,0,NULL::numeric,source_account_id,destination_account_id,fee_units,id,NULL::text,
           source_record_hash,NULL::text,NULL::text,NULL::text[],NULL::bigint,'standard'::text
    FROM portfolio_asset_transfers WHERE investment_id = ${investmentId}
    UNION ALL
    SELECT id,'asset_adjustment',to_char(date,'YYYY-MM-DD'),units,account_id,
           0,0,0,NULL::numeric,NULL::int,NULL::int,0,NULL::bigint,NULL::text,
           source_record_hash,adjustment_kind,basis_policy,eligible_source_record_hashes,id,'standard'::text
    FROM portfolio_asset_adjustments WHERE investment_id=${investmentId}
    ORDER BY date ASC, id ASC
  `,
  );
}

export async function getUnitEventIdsForImportBatch(
  batchId: number | string,
): Promise<{ id: PortfolioTransactionId; investment_id: InvestmentId }[]> {
  if (!(await hasPortfolioTransactionImportBatchIdColumn())) return [];
  return checkedRows(
    portfolioTransactionIdPairRowSchema,
    db
      .selectFrom("portfolio_transactions")
      .select(["id", "investment_id"])
      .where("import_batch_id", "=", String(batchId))
      .where("type", "in", ["buy", "gift", "sell", "split"])
      .orderBy("investment_id", "asc")
      .orderBy("id", "asc"),
  );
}

export async function getAccountLabel(accountId: AccountId): Promise<string> {
  const row = await checkedRow(
    accountLabelRowSchema,
    db
      .selectFrom("accounts")
      .select(["display_name", "name"])
      .where("id", "=", accountId),
  );
  return row?.display_name || row?.name || `account #${accountId}`;
}

// NUMERIC columns node-postgres returns as strings; coerce to numbers on emit
// so portfolio transaction rows match their `number` API/TS types.
const PORTFOLIO_TX_NUMERIC_FIELDS = [
  "amount",
  "units",
  "price_per_unit",
  "fees",
  "taxes",
  "fx_rate_to_eur",
];
// DATE columns node-postgres returns as local-midnight Date objects; emitted
// raw they JSON-serialize to an ISO timestamp that is the PREVIOUS day east of
// UTC. The frontend then T-splits that shifted value (edit dialogs wrote the
// date back one day earlier per save) or NaNs on it (parseLocalDateFromYmd).
// Emit calendar-day strings — the API/TS contract is `string` here.
const PORTFOLIO_TX_DATE_FIELDS = ["date", "recurrence_end_date"];
/**
 * Coerce a `portfolio_transactions` row to its emitted shape: NUMERIC columns
 * become numbers and both DATE columns 'YYYY-MM-DD' strings.
 */
export const mapPortfolioTxRow = (
  row: Record<string, unknown>,
): PortfolioTransactionRow => {
  const {
    source_record_hash: _sourceRecordHash,
    dedup_fingerprint: _dedupFingerprint,
    dedup_fingerprint_version: _dedupFingerprintVersion,
    ...publicRow
  } = row;
  const mapped = coerceNumericFields(publicRow, PORTFOLIO_TX_NUMERIC_FIELDS);
  for (const field of PORTFOLIO_TX_DATE_FIELDS) {
    const value = mapped[field];
    if (value instanceof Date) mapped[field] = toYmd(value);
  }
  mapped["income_recognition_role"] ??= "standard";
  // coerceNumericFields and the loop above convert the raw pg row in place.
  return mapped as PortfolioTransactionRow;
};

/** Narrow a `portfolio_transactions as pt` query to one investment and/or type. */
function whereListFilters<O>(
  builder: SelectQueryBuilder<
    DB & { pt: DB["portfolio_transactions"] },
    "pt",
    O
  >,
  {
    investmentId = null,
    type = null,
  }: { investmentId?: InvestmentId | null; type?: string | null },
) {
  let filtered = builder;
  if (investmentId != null)
    filtered = filtered.where("pt.investment_id", "=", investmentId);
  if (type) filtered = filtered.where(sql<string>`pt.type`, "=", type);
  return filtered;
}

type ListFilters = {
  investmentId?: InvestmentId | null;
  type?: string | null;
  limit?: number;
  offset?: number;
};

export async function getAll({
  investmentId = null,
  type = null,
  limit = 200,
  offset = 0,
}: ListFilters = {}): Promise<PortfolioTransactionRow[]> {
  const rows = await checkedRows(
    portfolioTransactionDbRowSchema,
    whereListFilters(
      db.selectFrom("portfolio_transactions as pt").selectAll("pt"),
      { investmentId, type },
    )
      .orderBy("pt.date", "desc")
      .orderBy("pt.id", "desc")
      .limit(limit)
      .offset(offset),
  );
  return rows.map(mapPortfolioTxRow);
}

export async function getAllWithCount({
  investmentId = null,
  type = null,
  limit = 200,
  offset = 0,
}: ListFilters = {}): Promise<{
  rows: PortfolioTransactionRow[];
  total: number;
}> {
  const countedRows = await checkedRows(
    portfolioTransactionCountedRowSchema,
    whereListFilters(
      db
        .selectFrom("portfolio_transactions as pt")
        .selectAll("pt")
        .select(sql<string>`COUNT(*) OVER ()`.as("total_count")),
      { investmentId, type },
    )
      .orderBy("pt.date", "desc")
      .orderBy("pt.id", "desc")
      .limit(limit)
      .offset(offset),
  );
  const [first] = countedRows;
  const total = first ? parseInt(first.total_count, 10) : 0;
  const rows = countedRows.map(({ total_count: _total_count, ...row }) =>
    mapPortfolioTxRow(row),
  );
  return { rows, total };
}

/**
 * Normalise an `investment_id` list for the `= ANY($1::int[])` predicates
 * below: dedupe, and keep only real ids.
 *
 * Kept rather than deleted even though `getBulkTransactions` now validates the
 * query param before it gets here, because this also does the dedupe the SQL
 * wants and the JSDoc contract of both callers still admits strings. What
 * changed is the element parse: it was `Number.parseInt`, which took the
 * leading digits of anything, so `['12abc']` normalised to `[12]` and the read
 * silently covered an investment the caller never named. Delegating to
 * `validateId` keeps the documented string form working (`'12'` → 12) while a
 * malformed entry is dropped instead of retargeting. Dropping, not throwing:
 * this layer has always been a silent filter, and the throwing guard now lives
 * at the route where a 400 can reach the caller.
 */
function normalizeInvestmentIds(
  investmentIds: ReadonlyArray<InvestmentId | string> | null | undefined,
): InvestmentId[] {
  const ids: InvestmentId[] = [];
  for (const id of investmentIds ?? []) {
    const result = validateId(id, "investment_id");
    if (result.valid) ids.push(asInvestmentId(result.value));
  }
  return Array.from(new Set(ids));
}

export async function getAllByInvestmentIds({
  investmentIds = [],
  type = null,
  perInvestmentLimit = 1000,
  limit = null,
  offset = 0,
}: {
  investmentIds?: Array<InvestmentId | string>;
  type?: string | null;
  perInvestmentLimit?: number;
  limit?: number | null;
  offset?: number;
} = {}): Promise<PortfolioTransactionRow[]> {
  const normalizedIds = normalizeInvestmentIds(investmentIds);

  if (normalizedIds.length === 0) return [];

  const safePerInvestmentLimit = Math.max(
    1,
    Math.min(nonZeroOr(Number.parseInt(String(perInvestmentLimit), 10), 1000), 5000),
  );
  const safeOffset = Math.max(0, nanToZero(Number.parseInt(String(offset), 10)));
  const safeLimit =
    limit == null
      ? null
      : Math.max(
          1,
          Math.min(
            nonZeroOr(
              Number.parseInt(String(limit), 10),
              normalizedIds.length * safePerInvestmentLimit,
            ),
            200000,
          ),
        );

  let ranked = db
    .selectFrom("portfolio_transactions as pt")
    .select([
      "pt.id",
      sql<number>`ROW_NUMBER() OVER (PARTITION BY pt.investment_id ORDER BY pt.date DESC, pt.id DESC)`.as(
        "rn",
      ),
    ])
    .where(
      "pt.investment_id",
      "=",
      sql<InvestmentId>`ANY(${normalizedIds}::int[])`,
    );
  if (type) ranked = ranked.where(sql<string>`pt.type`, "=", type);

  let builder = db
    .with("ranked", () => ranked)
    .with("limited", (qb) =>
      qb
        .selectFrom("ranked")
        .select("id")
        .where("rn", "<=", safePerInvestmentLimit),
    )
    .selectFrom("portfolio_transactions as pt")
    .innerJoin("limited as l", "l.id", "pt.id")
    .selectAll("pt")
    .orderBy("pt.date", "desc")
    .orderBy("pt.id", "desc");
  if (safeLimit != null) builder = builder.limit(safeLimit);

  const rows = await checkedRows(
    portfolioTransactionDbRowSchema,
    builder.offset(safeOffset),
  );
  return rows.map(mapPortfolioTxRow);
}

export async function getCount({
  investmentId = null,
  investmentIds = null,
  type = null,
}: {
  investmentId?: InvestmentId | null;
  investmentIds?: Array<InvestmentId | string> | null;
  type?: string | null;
} = {}): Promise<number> {
  let builder = db
    .selectFrom("portfolio_transactions")
    .select(sql<string>`count(*)`.as("count"));

  if (investmentId != null) {
    builder = builder.where("investment_id", "=", investmentId);
  } else if (Array.isArray(investmentIds) && investmentIds.length > 0) {
    const normalizedIds = normalizeInvestmentIds(investmentIds);
    if (normalizedIds.length > 0) {
      builder = builder.where(
        "investment_id",
        "=",
        sql<InvestmentId>`ANY(${normalizedIds}::int[])`,
      );
    }
  }
  if (type) builder = builder.where(sql<string>`type`, "=", type);

  const row = await checkedRow(countRowSchema, builder);
  return parseInt(row!.count, 10);
}

export async function getById(
  id: PortfolioTransactionId,
): Promise<PortfolioTransactionRow | null> {
  const row = await checkedRow(
    portfolioTransactionDbRowSchema,
    db.selectFrom("portfolio_transactions").selectAll().where("id", "=", id),
  );
  return row ? mapPortfolioTxRow(row) : null;
}

/**
 * Shared transaction loader for the portfolio math services (live summary and
 * snapshot builder): every portfolio transaction joined to its investment, with
 * the COALESCE defaults and calendar-day `to_char` date formatting both
 * consumers rely on. Parameterized only on the axes the call sites differ on
 * (active-investment filter, date window, within-day sell ordering).
 *
 * Rows are returned RAW — deliberately NOT passed through mapPortfolioTxRow.
 * The math paths coerce numerics themselves (Number()/Decimal), the date is
 * already emitted as a 'YYYY-MM-DD' string by to_char, and mapping here would
 * change NULL handling mid-calculation (e.g. fx_rate_to_eur NULL → 0, which
 * both consumers distinguish from a stamped rate).
 *
 * The transaction day is emitted under BOTH aliases (`date` and `day`) so each
 * consumer keeps its historical field name; the duplicate column is harmless
 * (same expression, no row-count effect).
 *
 * @param options.activeInvestmentsOnly restrict to transactions of active investments (i.is_active = true)
 * @param options.dateFrom inclusive YYYY-MM-DD lower bound on pt.date
 * @param options.dateTo inclusive YYYY-MM-DD upper bound on pt.date
 * @param options.sellsLastWithinDay replay ordering: sells after other types within the same day (snapshot day-walk); otherwise pt.date, pt.id
 * @returns raw joined rows
 */
export async function getRowsForPortfolioMath({
  activeInvestmentsOnly = false,
  dateFrom,
  dateTo,
  sellsLastWithinDay = false,
}: {
  activeInvestmentsOnly?: boolean;
  dateFrom?: string;
  dateTo?: string;
  sellsLastWithinDay?: boolean;
} = {}): Promise<PortfolioMathTxRow[]> {
  // The same filters apply to each event table's `date` column.
  const where = (dateColumn: string) => {
    const date = sql.ref(dateColumn);
    const conditions = [
      ...(activeInvestmentsOnly ? [sql`i.is_active = true`] : []),
      ...(dateFrom !== undefined ? [sql`${date} >= ${dateFrom}::date`] : []),
      ...(dateTo !== undefined ? [sql`${date} <= ${dateTo}::date`] : []),
    ];
    return conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;
  };
  const orderBy = sellsLastWithinDay
    ? sql`ORDER BY events.date, CASE WHEN events.type = 'sell' THEN 1 ELSE 0 END, events.id`
    : sql`ORDER BY events.date, events.id`;

  return checkedRows(
    portfolioMathTxRowSchema,
    sql`
    SELECT * FROM (
    SELECT pt.id, pt.investment_id, pt.type::text AS type,
           COALESCE(pt.amount, 0) AS amount,
           COALESCE(pt.units, 0) AS units,
           COALESCE(pt.fees, 0) AS fees,
           COALESCE(pt.taxes, 0) AS taxes,
           to_char(pt.date::date, 'YYYY-MM-DD') AS date,
           to_char(pt.date::date, 'YYYY-MM-DD') AS day,
           COALESCE(pt.currency, i.currency, 'EUR') AS currency,
           pt.fx_rate_to_eur,
           pt.account_id, NULL::int AS source_account_id,
           NULL::int AS destination_account_id, 0 AS fee_units,
           pt.source_record_hash, NULL::text AS adjustment_kind, NULL::text AS basis_policy,
           NULL::text[] AS eligible_source_record_hashes, pt.income_recognition_role
    FROM portfolio_transactions pt
    JOIN investments i ON i.id = pt.investment_id
    ${where("pt.date")}
    UNION ALL
    SELECT at.id, at.investment_id, 'asset_transfer' AS type, 0 AS amount,
            at.units, 0 AS fees, 0 AS taxes, to_char(at.date,'YYYY-MM-DD') AS date,
            to_char(at.date,'YYYY-MM-DD') AS day, COALESCE(i.currency,'EUR') AS currency,
            NULL::numeric AS fx_rate_to_eur, NULL::int AS account_id,
            at.source_account_id, at.destination_account_id, at.fee_units,
            at.source_record_hash,NULL::text,NULL::text,NULL::text[],'standard'::text
       FROM portfolio_asset_transfers at JOIN investments i ON i.id=at.investment_id
       ${where("at.date")}
    UNION ALL
    SELECT aa.id,aa.investment_id,'asset_adjustment',0,aa.units,0,0,
           to_char(aa.date,'YYYY-MM-DD'),to_char(aa.date,'YYYY-MM-DD'),COALESCE(i.currency,'EUR'),
           NULL::numeric,aa.account_id,NULL::int,NULL::int,0,aa.source_record_hash,
           aa.adjustment_kind,aa.basis_policy,aa.eligible_source_record_hashes,'standard'::text
      FROM portfolio_asset_adjustments aa JOIN investments i ON i.id=aa.investment_id
      ${where("aa.date")}
    ) events ${orderBy}`,
  );
}

const PORTFOLIO_SUMMARY_NUMERIC_FIELDS = [
  "total_amount",
  "total_units",
  "total_fees",
  "total_taxes",
];

export async function getSummary(
  investmentId: InvestmentId,
): Promise<PortfolioTransactionSummaryRow[]> {
  // SUM(NUMERIC) and COUNT(*) both arrive from pg as strings.
  const rows = await checkedRows(
    portfolioTransactionSummaryDbRowSchema,
    db
      .selectFrom("portfolio_transactions")
      .select((eb) => [
        "type",
        "income_recognition_role",
        eb.fn.sum<string>("amount").as("total_amount"),
        eb.fn.sum<string>("units").as("total_units"),
        eb.fn.sum<string>("fees").as("total_fees"),
        eb.fn.sum<string>("taxes").as("total_taxes"),
        eb.fn.countAll<string>().as("count"),
      ])
      .where("investment_id", "=", investmentId)
      .groupBy(["type", "income_recognition_role"]),
  );
  return rows.map(
    (row) =>
      // coerceNumericFields converts the NUMERIC strings to numbers at runtime.
      ({
        ...coerceNumericFields<Record<string, unknown>>(
          row,
          PORTFOLIO_SUMMARY_NUMERIC_FIELDS,
        ),
        count: parseInt(row.count, 10),
      }) as PortfolioTransactionSummaryRow,
  );
}
