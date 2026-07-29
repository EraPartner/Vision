/**
 * Portfolio transaction repo — read operations (list, count, getById, summary).
 */

import { query } from '../database/connection.js';
import { coerceNumericFields } from '../lib/money.js';
import { toYmd } from '../utils/portfolioMath.js';
import { buildListWhereClause } from './portfolioTxRepo.common.js';

/** @typedef {import('../types/rows.js').PortfolioTransactionRow} PortfolioTransactionRow */
/** @typedef {import('../types/rows.js').PortfolioTransactionSummaryRow} PortfolioTransactionSummaryRow */

// NUMERIC columns node-postgres returns as strings; coerce to numbers on emit
// so portfolio transaction rows match their `number` API/TS types.
const PORTFOLIO_TX_NUMERIC_FIELDS = ['amount', 'units', 'price_per_unit', 'fees', 'taxes', 'fx_rate_to_eur'];
// DATE columns node-postgres returns as local-midnight Date objects; emitted
// raw they JSON-serialize to an ISO timestamp that is the PREVIOUS day east of
// UTC. The frontend then T-splits that shifted value (edit dialogs wrote the
// date back one day earlier per save) or NaNs on it (parseLocalDateFromYmd).
// Emit calendar-day strings — the API/TS contract is `string` here.
const PORTFOLIO_TX_DATE_FIELDS = ['date', 'recurrence_end_date'];
/**
 * Coerce a `portfolio_transactions` row to its emitted shape: NUMERIC columns
 * become numbers and both DATE columns 'YYYY-MM-DD' strings.
 *
 * @param {any} row
 * @returns {PortfolioTransactionRow}
 */
export const mapPortfolioTxRow = (row) => {
  const mapped = coerceNumericFields(row, PORTFOLIO_TX_NUMERIC_FIELDS);
  for (const field of PORTFOLIO_TX_DATE_FIELDS) {
    if (mapped[field] instanceof Date) mapped[field] = toYmd(mapped[field]);
  }
  return mapped;
};

/**
 * @param {{ investmentId?: number|null, type?: string|null, limit?: number, offset?: number }} [filters]
 * @returns {Promise<PortfolioTransactionRow[]>}
 */
export async function getAll({ investmentId = null, type = null, limit = 200, offset = 0 } = {}) {
  const { where, params, nextParam } = buildListWhereClause({ investmentId, type });
  let sql = `SELECT * FROM portfolio_transactions ${where}`;
  let idx = nextParam;

  sql += ` ORDER BY date DESC, id DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit, offset);

  const result = await query(sql, params);
  return result.rows.map(mapPortfolioTxRow);
}

/**
 * @param {{ investmentId?: number|null, type?: string|null, limit?: number, offset?: number }} [filters]
 * @returns {Promise<{ rows: PortfolioTransactionRow[], total: number }>}
 */
export async function getAllWithCount({ investmentId = null, type = null, limit = 200, offset = 0 } = {}) {
  const { where, params, nextParam } = buildListWhereClause({ investmentId, type });
  let idx = nextParam;

  const sql = `
    SELECT pt.*, COUNT(*) OVER () AS total_count
    FROM portfolio_transactions pt
    ${where.replace(/\binvestment_id\b/g, 'pt.investment_id').replace(/\btype\b/g, 'pt.type')}
    ORDER BY pt.date DESC, pt.id DESC
    LIMIT $${idx} OFFSET $${idx + 1}
  `;

  const queryParams = [...params, limit, offset];
  const result = await query(sql, queryParams);
  const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
  const rows = result.rows.map((/** @type {any} */ { total_count: _total_count, ...row }) => mapPortfolioTxRow(row));
  return { rows, total };
}

/**
 * @param {{
 *   investmentIds?: Array<number|string>,
 *   type?: string|null,
 *   perInvestmentLimit?: number,
 *   limit?: number|null,
 *   offset?: number,
 * }} [filters]
 * @returns {Promise<PortfolioTransactionRow[]>}
 */
export async function getAllByInvestmentIds({
  investmentIds = [],
  type = null,
  perInvestmentLimit = 1000,
  limit = null,
  offset = 0,
} = {}) {
  const normalizedIds = Array.from(new Set((investmentIds || [])
    .map((/** @type {any} */ id) => Number.parseInt(id, 10))
    .filter((/** @type {number} */ id) => Number.isInteger(id) && id > 0)));

  if (normalizedIds.length === 0) return [];

  const safePerInvestmentLimit = Math.max(1, Math.min(Number.parseInt(String(perInvestmentLimit), 10) || 1000, 5000));
  const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
  const safeLimit = limit == null ? null : Math.max(1, Math.min(Number.parseInt(String(limit), 10) || normalizedIds.length * safePerInvestmentLimit, 200000));

  let sql = `
    WITH ranked AS (
      SELECT
        pt.id,
        ROW_NUMBER() OVER (PARTITION BY pt.investment_id ORDER BY pt.date DESC, pt.id DESC) AS rn
      FROM portfolio_transactions pt
      WHERE pt.investment_id = ANY($1::int[])
  `;
  /** @type {any[]} */
  const params = [normalizedIds, safePerInvestmentLimit];
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

  const result = await query(sql, params);
  return result.rows.map(mapPortfolioTxRow);
}

/**
 * @param {{ investmentId?: number|null, investmentIds?: Array<number|string>|null, type?: string|null }} [filters]
 * @returns {Promise<number>}
 */
export async function getCount({ investmentId = null, investmentIds = null, type = null } = {}) {
  let sql = `SELECT count(*) FROM portfolio_transactions WHERE 1=1`;
  /** @type {any[]} */
  const params = [];
  let idx = 1;

  if (investmentId) {
    sql += ` AND investment_id = $${idx++}`;
    params.push(investmentId);
  } else if (Array.isArray(investmentIds) && investmentIds.length > 0) {
    const normalizedIds = Array.from(new Set(investmentIds
      .map((/** @type {any} */ id) => Number.parseInt(id, 10))
      .filter((/** @type {number} */ id) => Number.isInteger(id) && id > 0)));
    if (normalizedIds.length > 0) {
      sql += ` AND investment_id = ANY($${idx++}::int[])`;
      params.push(normalizedIds);
    }
  }
  if (type) { sql += ` AND type = $${idx}`; params.push(type); }

  const result = await query(sql, params);
  return parseInt(result.rows[0].count, 10);
}

/**
 * @param {number} id
 * @returns {Promise<PortfolioTransactionRow|null>}
 */
export async function getById(id) {
  const result = await query('SELECT * FROM portfolio_transactions WHERE id = $1', [id]);
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
 * @param {object} [options]
 * @param {boolean} [options.activeInvestmentsOnly=false] restrict to transactions of active investments (i.is_active = true)
 * @param {string} [options.dateFrom] inclusive YYYY-MM-DD lower bound on pt.date
 * @param {string} [options.dateTo] inclusive YYYY-MM-DD upper bound on pt.date
 * @param {boolean} [options.sellsLastWithinDay=false] replay ordering: sells after other types within the same day (snapshot day-walk); otherwise pt.date, pt.id
 * @returns {Promise<import('../types/rows.js').PortfolioMathTxRow[]>} raw joined rows
 */
export async function getRowsForPortfolioMath({
  activeInvestmentsOnly = false,
  dateFrom,
  dateTo,
  sellsLastWithinDay = false,
} = {}) {
  const conditions = [];
  const params = [];

  if (activeInvestmentsOnly) conditions.push('i.is_active = true');
  if (dateFrom !== undefined) {
    params.push(dateFrom);
    conditions.push(`pt.date >= $${params.length}::date`);
  }
  if (dateTo !== undefined) {
    params.push(dateTo);
    conditions.push(`pt.date <= $${params.length}::date`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = sellsLastWithinDay
    ? `ORDER BY pt.date::date, CASE WHEN pt.type = 'sell' THEN 1 ELSE 0 END, pt.id`
    : 'ORDER BY pt.date::date, pt.id';

  const result = await query(`
    SELECT pt.id, pt.investment_id, pt.type,
           COALESCE(pt.amount, 0) AS amount,
           COALESCE(pt.units, 0) AS units,
           COALESCE(pt.fees, 0) AS fees,
           COALESCE(pt.taxes, 0) AS taxes,
           to_char(pt.date::date, 'YYYY-MM-DD') AS date,
           to_char(pt.date::date, 'YYYY-MM-DD') AS day,
           COALESCE(pt.currency, i.currency, 'EUR') AS currency,
           pt.fx_rate_to_eur,
           pt.account_id
    FROM portfolio_transactions pt
    JOIN investments i ON i.id = pt.investment_id
    ${where}
    ${orderBy}
  `, params);
  return result.rows;
}

const PORTFOLIO_SUMMARY_NUMERIC_FIELDS = ['total_amount', 'total_units', 'total_fees', 'total_taxes'];

/**
 * @param {number} investmentId
 * @returns {Promise<PortfolioTransactionSummaryRow[]>}
 */
export async function getSummary(investmentId) {
  const result = await query(`
    SELECT
      type,
      SUM(amount) as total_amount,
      SUM(units) as total_units,
      SUM(fees) as total_fees,
      SUM(taxes) as total_taxes,
      COUNT(*) as count
    FROM portfolio_transactions
    WHERE investment_id = $1
    GROUP BY type
  `, [investmentId]);
  return result.rows.map((/** @type {any} */ row) => ({
    ...coerceNumericFields(row, PORTFOLIO_SUMMARY_NUMERIC_FIELDS),
    count: parseInt(row.count, 10),
  }));
}
