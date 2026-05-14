/**
 * transactionExport — shared streaming CSV / NDJSON pipeline used by the
 * `GET /api/transactions/export/csv|json` routes and the `POST /bulk-export`
 * route. Keeps the filename, header, chunk SQL, and column projection in one
 * place so the two entry points cannot drift.
 */

import { query as dbQuery } from '../database/connection.js';
import { logger } from '../config/logger.js';
import { NotFoundError } from '../middleware/errorHandler.js';
import { toDecimal } from '../lib/money.js';
import { escapeCsvValue } from '../lib/csv.js';

export const EXPORT_CHUNK_SIZE = 1000;
export const EXPORT_MAX_LIST_SIZE = 50;

/**
 * Shared FROM + JOIN block for transaction list/export queries. Exported so
 * `bulkSelection` runs against the exact same join shape.
 */
export const EXPORT_JOINS_SQL = `
    FROM transactions t
    LEFT JOIN recipients r ON t.recipient_id = r.id
    LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN categories rc ON r.default_category_id = rc.id
    LEFT JOIN categories pc ON pr.default_category_id = pc.id`;

function buildExportTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function buildCsvFilename() {
  return `transactions_export_${buildExportTimestamp()}.csv`;
}

export function buildNdjsonFilename() {
  return `transactions_export_${buildExportTimestamp()}.ndjson`;
}

function buildExportProbeSql(whereSql) {
  return `SELECT 1 ${EXPORT_JOINS_SQL} WHERE ${whereSql} LIMIT 1`;
}

/**
 * Write a chunk to the response, respecting backpressure. When the socket
 * buffer is full `res.write` returns false — without this a slow client lets
 * rows buffer unboundedly in memory on a large export.
 *
 * @param {import('express').Response} res
 * @param {string} chunk
 * @returns {Promise<void>}
 */
function writeWithBackpressure(res, chunk) {
  // `res.once` is missing on minimal/mocked response objects — in that case
  // there's no drain event to await, so just resolve.
  if (res.write(chunk) || typeof res.once !== 'function') return Promise.resolve();
  return new Promise((resolve) => res.once('drain', resolve));
}

function buildExportChunkSql(whereSql, limitParamIdx, offsetParamIdx) {
  return `
    SELECT t.id, t.date, t.bank_account,
           COALESCE(pr.name, r.name) AS recipient_name, t.memo,
           t.amount, t.currency, t.balance,
           CASE
             WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
             WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
             WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
             ELSE ''
           END AS category_name,
           t.comment,
           COALESCE(
             (SELECT array_agg(tg.slug ORDER BY tg.slug)
              FROM transaction_tags tt
              JOIN tags tg ON tg.id = tt.tag_id
              WHERE tt.transaction_id = t.id AND tg.is_active = true),
             '{}'::text[]
           ) AS tags
    ${EXPORT_JOINS_SQL}
    WHERE ${whereSql}
    ORDER BY t.date ASC, t.id ASC
    LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
  `;
}

function buildCsvRow(row, { includeBalance = false } = {}) {
  const cols = [
    row.date,
    row.bank_account,
    row.recipient_name,
    row.memo,
    row.amount,
    row.currency,
    row.balance,
    row.category_name,
    row.comment,
    Array.isArray(row.tags) ? row.tags.join(';') : '',
  ];
  if (includeBalance) cols.push(row.running_balance);
  return cols.map(escapeCsvValue).join(',');
}

function buildNdjsonRow(row) {
  return JSON.stringify({
    id: row.id,
    date: row.date,
    bank_account: row.bank_account,
    recipient: row.recipient_name ?? null,
    memo: row.memo ?? null,
    amount: row.amount,
    currency: row.currency ?? null,
    balance: row.balance ?? null,
    category: row.category_name || null,
    comment: row.comment ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
  });
}

/**
 * Build a probe + iterate-in-chunks pipeline that streams export rows to `res`.
 * Returns `{ rowCount }` when the stream completes cleanly.
 *
 * @param {import('express').Response} res
 * @param {{
 *   whereSql: string,
 *   params: any[],
 *   nextParamIdx: number,
 *   contentType: string,
 *   filename: string,
 *   writeHeader?: (res: import('express').Response) => void,
 *   formatRow: (row: any, rowIndex: number) => string,
 *   label: string,
 * }} opts
 */
async function streamExport(res, { whereSql, params, nextParamIdx, contentType, filename, writeHeader, formatRow, label }) {
  const probe = await dbQuery(buildExportProbeSql(whereSql), params);
  if (probe.rows.length === 0) {
    throw new NotFoundError('No transactions found matching filters');
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

  if (writeHeader) writeHeader(res);

  const chunkSql = buildExportChunkSql(whereSql, nextParamIdx, nextParamIdx + 1);
  let chunkOffset = 0;
  let rowCount = 0;
  try {
    while (true) {
      const chunk = await dbQuery(chunkSql, [...params, EXPORT_CHUNK_SIZE, chunkOffset]);
      if (chunk.rows.length === 0) break;
      for (const row of chunk.rows) {
        await writeWithBackpressure(res, formatRow(row, rowCount));
        rowCount++;
      }
      if (chunk.rows.length < EXPORT_CHUNK_SIZE) break;
      chunkOffset += EXPORT_CHUNK_SIZE;
    }
    res.end();
    return { rowCount };
  } catch (err) {
    if (res.headersSent) {
      logger.error(`${label} export failed mid-stream`, { error: err.message });
      res.end();
      return { rowCount };
    }
    throw err;
  }
}

export async function streamCsvExport(res, { whereSql, params, nextParamIdx, includeBalance = false }) {
  // Kept as a Decimal across the whole stream — collapsing to a JS number each
  // row re-ingested a drifted float into the next step's running balance.
  let runningBalance = toDecimal(0);
  return streamExport(res, {
    whereSql,
    params,
    nextParamIdx,
    contentType: 'text/csv',
    filename: buildCsvFilename(),
    writeHeader(target) {
      const header = includeBalance
        ? 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Tags,Running Balance'
        : 'Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Tags';
      target.write(`${header}\n`);
    },
    formatRow(row) {
      if (includeBalance) {
        runningBalance = runningBalance.plus(toDecimal(row.amount ?? 0));
        return `${buildCsvRow({ ...row, running_balance: runningBalance.toNumber() }, { includeBalance })}\n`;
      }
      return `${buildCsvRow(row)}\n`;
    },
    label: 'CSV',
  });
}

export async function streamNdjsonExport(res, { whereSql, params, nextParamIdx }) {
  return streamExport(res, {
    whereSql,
    params,
    nextParamIdx,
    contentType: 'application/x-ndjson',
    filename: buildNdjsonFilename(),
    formatRow(row) {
      return `${buildNdjsonRow(row)}\n`;
    },
    label: 'JSON',
  });
}

/**
 * Helper used by the POST /bulk-export route: builds a WHERE clause that
 * targets a fixed list of ids while leaving the param numbering compatible
 * with the chunk-SQL builder (which appends LIMIT/OFFSET).
 */
export function buildIdListWhere(ids) {
  return {
    whereSql: 't.id = ANY($1::int[])',
    params: [ids],
    nextParamIdx: 2,
  };
}
