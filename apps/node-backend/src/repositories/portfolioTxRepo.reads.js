/**
 * Portfolio transaction repo — read operations (list, count, getById, summary).
 */

import { query } from '../database/connection.js';
import { coerceNumericFields } from '../lib/money.js';
import { toYmd } from '../utils/portfolioMath.js';
import { buildListWhereClause } from './portfolioTxRepo.common.js';

// NUMERIC columns node-postgres returns as strings; coerce to numbers on emit
// so portfolio transaction rows match their `number` API/TS types.
const PORTFOLIO_TX_NUMERIC_FIELDS = ['amount', 'units', 'price_per_unit', 'fees', 'taxes', 'fx_rate_to_eur'];
// DATE columns node-postgres returns as local-midnight Date objects; emitted
// raw they JSON-serialize to an ISO timestamp that is the PREVIOUS day east of
// UTC. The frontend then T-splits that shifted value (edit dialogs wrote the
// date back one day earlier per save) or NaNs on it (parseLocalDateFromYmd).
// Emit calendar-day strings — the API/TS contract is `string` here.
const PORTFOLIO_TX_DATE_FIELDS = ['date', 'recurrence_end_date'];
export const mapPortfolioTxRow = (row) => {
  const mapped = coerceNumericFields(row, PORTFOLIO_TX_NUMERIC_FIELDS);
  for (const field of PORTFOLIO_TX_DATE_FIELDS) {
    if (mapped[field] instanceof Date) mapped[field] = toYmd(mapped[field]);
  }
  return mapped;
};

export async function getAll({ investmentId = null, type = null, limit = 200, offset = 0 } = {}) {
  const { where, params, nextParam } = buildListWhereClause({ investmentId, type });
  let sql = `SELECT * FROM portfolio_transactions ${where}`;
  let idx = nextParam;

  sql += ` ORDER BY date DESC, id DESC LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit, offset);

  const result = await query(sql, params);
  return result.rows.map(mapPortfolioTxRow);
}

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
  const rows = result.rows.map(({ total_count: _total_count, ...row }) => mapPortfolioTxRow(row));
  return { rows, total };
}

export async function getAllByInvestmentIds({
  investmentIds = [],
  type = null,
  perInvestmentLimit = 1000,
  limit = null,
  offset = 0,
} = {}) {
  const normalizedIds = Array.from(new Set((investmentIds || [])
    .map((id) => Number.parseInt(id, 10))
    .filter((id) => Number.isInteger(id) && id > 0)));

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

export async function getCount({ investmentId = null, investmentIds = null, type = null } = {}) {
  let sql = `SELECT count(*) FROM portfolio_transactions WHERE 1=1`;
  const params = [];
  let idx = 1;

  if (investmentId) {
    sql += ` AND investment_id = $${idx++}`;
    params.push(investmentId);
  } else if (Array.isArray(investmentIds) && investmentIds.length > 0) {
    const normalizedIds = Array.from(new Set(investmentIds
      .map((id) => Number.parseInt(id, 10))
      .filter((id) => Number.isInteger(id) && id > 0)));
    if (normalizedIds.length > 0) {
      sql += ` AND investment_id = ANY($${idx++}::int[])`;
      params.push(normalizedIds);
    }
  }
  if (type) { sql += ` AND type = $${idx}`; params.push(type); }

  const result = await query(sql, params);
  return parseInt(result.rows[0].count, 10);
}

export async function getById(id) {
  const result = await query('SELECT * FROM portfolio_transactions WHERE id = $1', [id]);
  return result.rows[0] ? mapPortfolioTxRow(result.rows[0]) : null;
}

const PORTFOLIO_SUMMARY_NUMERIC_FIELDS = ['total_amount', 'total_units', 'total_fees', 'total_taxes'];

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
  return result.rows.map((row) => ({
    ...coerceNumericFields(row, PORTFOLIO_SUMMARY_NUMERIC_FIELDS),
    count: parseInt(row.count, 10),
  }));
}
