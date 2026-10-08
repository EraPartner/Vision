/**
 * Portfolio transaction repo — read operations (list, count, getById, summary).
 */

import { query } from "../database/connection.ts";
import { coerceNumericFields } from "../lib/money.ts";
import { toYmd } from "../lib/dateFormat.ts";
import { validateId } from "../lib/validation.ts";
import { buildListWhereClause } from "./portfolioTxRepo.common.ts";
import { hasPortfolioTransactionImportBatchIdColumn } from "./portfolioTxRepo.common.ts";

import type {
  PortfolioMathTxRow,
  PortfolioTransactionRow,
  PortfolioTransactionSummaryRow,
} from "../types/rows.ts";

export type { PortfolioTransactionRow, PortfolioTransactionSummaryRow };

/**
 * One custody-relevant unit event: a portfolio transaction, asset transfer or
 * asset adjustment. The UNION widens ids to BIGINT and the numeric columns to
 * NUMERIC, so pg emits them as strings.
 */
export type PortfolioUnitEventRow = {
  id: string;
  type: string;
  /** 'YYYY-MM-DD' */
  date: string;
  units: string;
  account_id: number | null;
  amount: string;
  fees: string;
  taxes: string;
  fxMultiplier: string | null;
  source_account_id: number | null;
  destination_account_id: number | null;
  fee_units: string;
  transfer_id: string | null;
  currency: string | null;
  source_record_hash: string | null;
  adjustment_kind: "yield_reversal" | "asset_fee" | null;
  basis_policy: "zero_yield_only" | "carried" | null;
  eligible_source_record_hashes: string[] | null;
  adjustment_id: string | null;
};

export async function getAssetClassByInvestmentId(
  investmentId: number,
): Promise<string | undefined> {
  const result = await query<{ asset_class: string }>(
    "SELECT asset_class FROM investments WHERE id = $1",
    [investmentId],
  );
  return result.rows[0]?.asset_class;
}

export async function getUnitEventsForInvestment(
  investmentId: number,
): Promise<PortfolioUnitEventRow[]> {
  const sql = `
    SELECT id, type::text AS type, to_char(date, 'YYYY-MM-DD') AS date,
           COALESCE(units, 0) AS units, account_id, amount, fees, taxes,
           CASE WHEN COALESCE(currency,'EUR')='EUR' THEN 1 ELSE COALESCE(fx_rate_to_eur,
             (SELECT er.rate_to_eur FROM exchange_rates er WHERE er.currency_code=portfolio_transactions.currency AND er.rate_date<=portfolio_transactions.date ORDER BY er.rate_date DESC LIMIT 1)) END AS "fxMultiplier", NULL::int AS source_account_id,
           NULL::int AS destination_account_id, 0 AS fee_units, NULL::bigint AS transfer_id, currency,
           source_record_hash, NULL::text AS adjustment_kind, NULL::text AS basis_policy,
           NULL::text[] AS eligible_source_record_hashes, NULL::bigint AS adjustment_id, income_recognition_role
    FROM portfolio_transactions WHERE investment_id = $1
    UNION ALL
    SELECT id, 'asset_transfer', to_char(date,'YYYY-MM-DD'), units, NULL::int,
           0,0,0,NULL::numeric,source_account_id,destination_account_id,fee_units,id,NULL::text,
           source_record_hash,NULL::text,NULL::text,NULL::text[],NULL::bigint,'standard'::text
    FROM portfolio_asset_transfers WHERE investment_id = $1
    UNION ALL
    SELECT id,'asset_adjustment',to_char(date,'YYYY-MM-DD'),units,account_id,
           0,0,0,NULL::numeric,NULL::int,NULL::int,0,NULL::bigint,NULL::text,
           source_record_hash,adjustment_kind,basis_policy,eligible_source_record_hashes,id,'standard'::text
    FROM portfolio_asset_adjustments WHERE investment_id=$1
    ORDER BY date ASC, id ASC
  `;
  return (await query<PortfolioUnitEventRow>(sql, [investmentId])).rows;
}

export async function getUnitEventIdsForImportBatch(
  batchId: number | string,
): Promise<{ id: number; investment_id: number }[]> {
  if (!(await hasPortfolioTransactionImportBatchIdColumn())) return [];
  const result = await query<{ id: number; investment_id: number }>(
    `SELECT id, investment_id
     FROM portfolio_transactions
     WHERE import_batch_id = $1
       AND type = ANY($2::portfolio_txn_type[])
     ORDER BY investment_id ASC, id ASC`,
    [batchId, ["buy", "gift", "sell", "split"]],
  );
  return result.rows;
}

export async function getAccountLabel(accountId: number): Promise<string> {
  const result = await query<{
    display_name: string | null;
    name: string | null;
  }>("SELECT display_name, name FROM accounts WHERE id = $1", [accountId]);
  const row = result.rows[0];
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

type ListFilters = {
  investmentId?: number | null;
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
  const { where, params, nextParam } = buildListWhereClause({
    investmentId,
    type,
  });
  let sql = `SELECT * FROM portfolio_transactions ${where}`;
  const idx = nextParam;

  sql += ` ORDER BY date DESC, id DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit, offset);

  const result = await query<Record<string, unknown>>(sql, params);
  return result.rows.map(mapPortfolioTxRow);
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
  const { where, params, nextParam } = buildListWhereClause({
    investmentId,
    type,
  });
  const idx = nextParam;

  const sql = `
    SELECT pt.*, COUNT(*) OVER () AS total_count
    FROM portfolio_transactions pt
    ${where.replace(/\binvestment_id\b/g, "pt.investment_id").replace(/\btype\b/g, "pt.type")}
    ORDER BY pt.date DESC, pt.id DESC
    LIMIT $${idx} OFFSET $${idx + 1}
  `;

  const queryParams = [...params, limit, offset];
  const result = await query<Record<string, unknown> & { total_count: string }>(
    sql,
    queryParams,
  );
  const total =
    result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
  const rows = result.rows.map(({ total_count: _total_count, ...row }) =>
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
  investmentIds: ReadonlyArray<number | string> | null | undefined,
): number[] {
  const ids: number[] = [];
  for (const id of investmentIds || []) {
    const result = validateId(id, "investment_id");
    if (result.valid) ids.push(result.value);
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
  investmentIds?: Array<number | string>;
  type?: string | null;
  perInvestmentLimit?: number;
  limit?: number | null;
  offset?: number;
} = {}): Promise<PortfolioTransactionRow[]> {
  const normalizedIds = normalizeInvestmentIds(investmentIds);

  if (normalizedIds.length === 0) return [];

  const safePerInvestmentLimit = Math.max(
    1,
    Math.min(Number.parseInt(String(perInvestmentLimit), 10) || 1000, 5000),
  );
  const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
  const safeLimit =
    limit == null
      ? null
      : Math.max(
          1,
          Math.min(
            Number.parseInt(String(limit), 10) ||
              normalizedIds.length * safePerInvestmentLimit,
            200000,
          ),
        );

  let sql = `
    WITH ranked AS (
      SELECT
        pt.id,
        ROW_NUMBER() OVER (PARTITION BY pt.investment_id ORDER BY pt.date DESC, pt.id DESC) AS rn
      FROM portfolio_transactions pt
      WHERE pt.investment_id = ANY($1::int[])
  `;
  const params: unknown[] = [normalizedIds, safePerInvestmentLimit];
  let idx = 3;

  if (type) {
    sql += ` AND pt.type = $${idx++}`;
    params.push(type);
  }

  sql += `
    ),
    limited AS (
      SELECT id
      FROM ranked
      WHERE rn <= $2
    )
    SELECT pt.*
    FROM portfolio_transactions pt
    JOIN limited l ON l.id = pt.id
    ORDER BY pt.date DESC, pt.id DESC
  `;

  if (safeLimit != null) {
    sql += ` LIMIT $${idx++}`;
    params.push(safeLimit);
  }

  sql += ` OFFSET $${idx}`;
  params.push(safeOffset);

  const result = await query<Record<string, unknown>>(sql, params);
  return result.rows.map(mapPortfolioTxRow);
}

export async function getCount({
  investmentId = null,
  investmentIds = null,
  type = null,
}: {
  investmentId?: number | null;
  investmentIds?: Array<number | string> | null;
  type?: string | null;
} = {}): Promise<number> {
  let sql = `SELECT count(*) FROM portfolio_transactions WHERE 1=1`;
  const params: unknown[] = [];
  let idx = 1;

  if (investmentId) {
    sql += ` AND investment_id = $${idx++}`;
    params.push(investmentId);
  } else if (Array.isArray(investmentIds) && investmentIds.length > 0) {
    const normalizedIds = normalizeInvestmentIds(investmentIds);
    if (normalizedIds.length > 0) {
      sql += ` AND investment_id = ANY($${idx++}::int[])`;
      params.push(normalizedIds);
    }
  }
  if (type) {
    sql += ` AND type = $${idx}`;
    params.push(type);
  }

  const result = await query<{ count: string }>(sql, params);
  return parseInt(result.rows[0].count, 10);
}

export async function getById(
  id: number,
): Promise<PortfolioTransactionRow | null> {
  const result = await query<Record<string, unknown>>(
    "SELECT * FROM portfolio_transactions WHERE id = $1",
    [id],
  );
  return result.rows[0] ? mapPortfolioTxRow(result.rows[0]) : null;
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
  const conditions: string[] = [];
  const params: string[] = [];

  if (activeInvestmentsOnly) conditions.push("i.is_active = true");
  if (dateFrom !== undefined) {
    params.push(dateFrom);
    conditions.push(`pt.date >= $${params.length}::date`);
  }
  if (dateTo !== undefined) {
    params.push(dateTo);
    conditions.push(`pt.date <= $${params.length}::date`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderBy = sellsLastWithinDay
    ? `ORDER BY events.date, CASE WHEN events.type = 'sell' THEN 1 ELSE 0 END, events.id`
    : "ORDER BY events.date, events.id";

  const result = await query<PortfolioMathTxRow>(
    `
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
    ${where}
    UNION ALL
    SELECT at.id, at.investment_id, 'asset_transfer' AS type, 0 AS amount,
            at.units, 0 AS fees, 0 AS taxes, to_char(at.date,'YYYY-MM-DD') AS date,
            to_char(at.date,'YYYY-MM-DD') AS day, COALESCE(i.currency,'EUR') AS currency,
            NULL::numeric AS fx_rate_to_eur, NULL::int AS account_id,
            at.source_account_id, at.destination_account_id, at.fee_units,
            at.source_record_hash,NULL::text,NULL::text,NULL::text[],'standard'::text
       FROM portfolio_asset_transfers at JOIN investments i ON i.id=at.investment_id
       ${where.replace(/pt\.date/g, "at.date")}
    UNION ALL
    SELECT aa.id,aa.investment_id,'asset_adjustment',0,aa.units,0,0,
           to_char(aa.date,'YYYY-MM-DD'),to_char(aa.date,'YYYY-MM-DD'),COALESCE(i.currency,'EUR'),
           NULL::numeric,aa.account_id,NULL::int,NULL::int,0,aa.source_record_hash,
           aa.adjustment_kind,aa.basis_policy,aa.eligible_source_record_hashes,'standard'::text
      FROM portfolio_asset_adjustments aa JOIN investments i ON i.id=aa.investment_id
      ${where.replace(/pt\.date/g, "aa.date")}
    ) events ${orderBy}`,
    params,
  );
  return result.rows;
}

const PORTFOLIO_SUMMARY_NUMERIC_FIELDS = [
  "total_amount",
  "total_units",
  "total_fees",
  "total_taxes",
];

export async function getSummary(
  investmentId: number,
): Promise<PortfolioTransactionSummaryRow[]> {
  // SUM(NUMERIC) and COUNT(*) both arrive from pg as strings.
  const result = await query<Record<string, unknown> & { count: string }>(
    `
    SELECT
      type, income_recognition_role,
      SUM(amount) as total_amount,
      SUM(units) as total_units,
      SUM(fees) as total_fees,
      SUM(taxes) as total_taxes,
      COUNT(*) as count
    FROM portfolio_transactions
    WHERE investment_id = $1
    GROUP BY type, income_recognition_role
  `,
    [investmentId],
  );
  return result.rows.map(
    (row) =>
      // coerceNumericFields converts the NUMERIC strings to numbers at runtime.
      ({
        ...coerceNumericFields(row, PORTFOLIO_SUMMARY_NUMERIC_FIELDS),
        count: parseInt(row.count, 10),
      }) as PortfolioTransactionSummaryRow,
  );
}
