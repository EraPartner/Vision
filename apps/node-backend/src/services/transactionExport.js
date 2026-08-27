/**
 * transactionExport — shared streaming CSV / NDJSON pipeline used by the
 * `GET /api/transactions/export/csv|json` routes and the `POST /bulk-export`
 * route. Keeps the filename, header, chunk SQL, and column projection in one
 * place so the two entry points cannot drift.
 */

import { query as dbQuery } from "../database/connection.js";
import { logger } from "../config/logger.js";
import { NotFoundError } from "../middleware/errorHandler.js";
import { toDecimal } from "../lib/money.js";
import { toYmd } from "./calculations/portfolioMath.js";
import { escapeCsvValue } from "../lib/csv.js";

/**
 * The slice of an Express `Response` this module actually calls. Deliberately
 * structural rather than `import('express').Response`: express ships no type
 * declarations and `@types/express` is not a dependency, so referencing its
 * types resolves to an implicit `any` (TS7016) under `noImplicitAny` — same
 * reasoning as `ExpressApp` in services/routeManifest.js and `QueryRunner` in
 * types/rows.js for `pg`.
 * @typedef {object} ExpressResponse
 * @property {(name: string, value: string) => void} setHeader
 * @property {(chunk: string) => boolean} write
 * @property {(event: string, cb: () => void) => void} [once]
 * @property {boolean} [headersSent]
 * @property {() => void} end
 * @property {(error?: Error) => void} [destroy]
 */

/**
 * @typedef {(sql: string, params?: any[]) => Promise<{rows: ExportTransactionRow[]|any[]}>} ExportQuery
 */

/**
 * A row as selected by `buildExportChunkSql` — a projection of
 * `EnrichedTransactionRow`, not the full row (no `is_active`, `recipient_id`,
 * etc. — only the columns the export needs).
 * @typedef {object} ExportTransactionRow
 * @property {number} id
 * @property {Date} date DATE — local-midnight `Date`; read via `toYmd`, never `String()`/`toISOString()`.
 * @property {string|null} bank_account
 * @property {number|null} [account_id]
 * @property {string|null} recipient_name
 * @property {string|null} memo
 * @property {string} amount NUMERIC(18,4) — pg emits NUMERIC as a string.
 * @property {string|null} currency
 * @property {string|null} balance NUMERIC(18,4) since migration 0088 — pg emits NUMERIC as a string; null on manual rows.
 * @property {string} category_name '' when the transaction has no resolved category.
 * @property {string|null} comment
 * @property {string[]} tags tag slugs, `{}` (empty array) when none.
 */

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
    LEFT JOIN categories pc ON pr.default_category_id = pc.id
    LEFT JOIN accounts acct ON t.account_id = acct.id`;

function buildExportTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function buildCsvFilename() {
  return `transactions_export_${buildExportTimestamp()}.csv`;
}

function buildNdjsonFilename() {
  return `transactions_export_${buildExportTimestamp()}.ndjson`;
}

/**
 * @param {string} whereSql
 * @returns {string}
 */
function buildExportProbeSql(whereSql) {
  return `SELECT 1 ${EXPORT_JOINS_SQL} WHERE ${whereSql} LIMIT 1`;
}

/**
 * Write a chunk to the response, respecting backpressure. When the socket
 * buffer is full `res.write` returns false — without this a slow client lets
 * rows buffer unboundedly in memory on a large export.
 *
 * @param {ExpressResponse} res
 * @param {string} chunk
 * @returns {Promise<void>}
 */
function writeWithBackpressure(res, chunk) {
  // `res.once` is missing on minimal/mocked response objects — in that case
  // there's no drain event to await, so just resolve.
  if (res.write(chunk) || typeof res.once !== "function")
    return Promise.resolve();
  return new Promise((resolve) => res.once("drain", resolve));
}

/**
 * @param {string} whereSql
 * @param {number} limitParamIdx
 * @param {number} [cursorDateParamIdx]
 * @param {number} [cursorIdParamIdx]
 * @returns {string}
 */
function buildExportChunkSql(
  whereSql,
  limitParamIdx,
  cursorDateParamIdx,
  cursorIdParamIdx,
) {
  // Keyset pagination: each chunk continues strictly after the previous chunk's
  // last (date, id) instead of OFFSET. OFFSET across separate pool queries (new
  // snapshot each time) silently dropped/duplicated rows when a concurrent
  // insert/delete shifted the result set mid-export. (date, id) is unique
  // (t.id) so the cursor is exact and the scan is index-friendly.
  const keyset =
    cursorDateParamIdx != null
      ? `AND (t.date, t.id) > ($${cursorDateParamIdx}::date, $${cursorIdParamIdx}::bigint)`
      : "";
  return `
    SELECT t.id, t.date, acct.name AS bank_account, t.account_id,
           COALESCE(pr.name, r.name) AS recipient_name, t.memo,
           t.amount, t.currency, t.balance,
           -- Same branch order as transactionRepository's CATEGORY_NAME_SQL:
           -- own (c) → recipient default (rc) → primary-recipient default (pc),
           -- mirroring COALESCE(t.category_id, r.default_category_id,
           -- pr.default_category_id). It used to test pc before rc, so an
           -- ALIAS recipient with its own default under a differently-defaulted
           -- PRIMARY exported the primary's category name while the
           -- transactions list showed the alias's.
           CASE
             WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
             WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
             WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
             ELSE ''
           END AS category_name,
           t.comment,
           COALESCE(tag_agg.tags, '{}'::text[]) AS tags
    ${EXPORT_JOINS_SQL}
    LEFT JOIN (
      SELECT tt.transaction_id, array_agg(tg.slug ORDER BY tg.slug) AS tags
      FROM transaction_tags tt
      JOIN tags tg ON tg.id = tt.tag_id
      WHERE tg.is_active = true
      GROUP BY tt.transaction_id
    ) tag_agg ON tag_agg.transaction_id = t.id
    WHERE ${whereSql}
      ${keyset}
    ORDER BY t.date ASC, t.id ASC
    LIMIT $${limitParamIdx}
  `;
}

/**
 * @param {ExportTransactionRow & { running_balance?: string }} row
 * @param {{ includeBalance?: boolean }} [opts]
 * @returns {string}
 */
function buildCsvRow(row, { includeBalance = false } = {}) {
  const cols = [
    // toYmd, not the raw pg Date: String() of it is "Wed Jul 01 2026 …" —
    // unusable in Excel and a day off on cross-TZ re-import.
    escapeCsvValue(toYmd(row.date)),
    escapeCsvValue(row.bank_account),
    escapeCsvValue(row.recipient_name),
    escapeCsvValue(row.memo),
    escapeCsvValue(row.amount),
    escapeCsvValue(row.currency),
    escapeCsvValue(row.balance),
    escapeCsvValue(row.category_name),
    escapeCsvValue(row.comment),
    escapeCsvValue(Array.isArray(row.tags) ? row.tags.join(";") : ""),
  ];
  if (includeBalance) cols.push(escapeCsvValue(row.running_balance));
  return cols.join(",");
}

/**
 * @param {ExportTransactionRow} row
 * @returns {string}
 */
function buildNdjsonRow(row) {
  return JSON.stringify({
    id: row.id,
    // toYmd, not the raw pg Date: JSON.stringify would toISOString it into
    // the PREVIOUS day's timestamp on any backend east of UTC.
    date: toYmd(row.date),
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
 * @param {ExpressResponse} res
 * @param {{
 *   whereSql: string,
 *   params: any[],
 *   nextParamIdx: number,
 *   contentType: string,
 *   filename: string,
 *   writeHeader?: (res: ExpressResponse) => void,
 *   formatRow: (row: ExportTransactionRow, rowIndex: number) => string,
 *   label: string,
 *   query?: (sql: string, params?: any[]) => Promise<{rows: ExportTransactionRow[]|any[]}>,
 * }} opts
 * @returns {Promise<{ rowCount: number }>}
 */
async function streamExport(
  res,
  {
    whereSql,
    params,
    nextParamIdx,
    contentType,
    filename,
    writeHeader,
    formatRow,
    label,
    query = dbQuery,
  },
) {
  const probe = await query(buildExportProbeSql(whereSql), params);
  if (probe.rows.length === 0) {
    throw new NotFoundError("No transactions found matching filters");
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

  if (writeHeader) writeHeader(res);

  // Keyset cursor (last streamed (date, id)). First chunk has no cursor.
  /** @type {string|null} */
  let cursorDate = null;
  /** @type {number|null} */
  let cursorId = null;
  let rowCount = 0;
  try {
    while (true) {
      /** @type {{ rows: ExportTransactionRow[] }} */
      const chunk =
        cursorDate == null
          ? await query(buildExportChunkSql(whereSql, nextParamIdx), [
              ...params,
              EXPORT_CHUNK_SIZE,
            ])
          : await query(
              buildExportChunkSql(
                whereSql,
                nextParamIdx,
                nextParamIdx + 1,
                nextParamIdx + 2,
              ),
              [...params, EXPORT_CHUNK_SIZE, cursorDate, cursorId],
            );
      if (chunk.rows.length === 0) break;
      for (const row of chunk.rows) {
        await writeWithBackpressure(res, formatRow(row, rowCount));
        rowCount++;
      }
      const last = chunk.rows[chunk.rows.length - 1];
      // toYmd recovers the local calendar day from pg's local-midnight Date so
      // the ::date cursor never shifts a day in a UTC+ zone.
      cursorDate = toYmd(last.date);
      cursorId = last.id;
      if (chunk.rows.length < EXPORT_CHUNK_SIZE) break;
    }
    res.end();
    return { rowCount };
  } catch (err) {
    if (res.headersSent) {
      logger.error(`${label} export failed mid-stream`, { error: err.message });
      if (res.destroy) res.destroy(err);
      else res.end();
      throw err;
    }
    throw err;
  }
}

/**
 * @param {ExpressResponse} res
 * @param {{ whereSql: string, params: any[], nextParamIdx: number, includeBalance?: boolean, query?: ExportQuery }} args
 * @returns {Promise<{ rowCount: number }>}
 */
export async function streamCsvExport(
  res,
  { whereSql, params, nextParamIdx, includeBalance = false, query },
) {
  // Partitioned by account_id (ADR-088): the list endpoint's window partitions
  // by account because a stream spanning multiple accounts otherwise sums them
  // into one meaningless cross-account total. Kept as Decimals across the whole
  // stream — collapsing to a JS number each row re-ingested a drifted float
  // into the next step's running balance.
  /** @type {Map<number|null, import('decimal.js').Decimal>} */
  const runningBalances = new Map();
  return streamExport(res, {
    whereSql,
    params,
    nextParamIdx,
    contentType: "text/csv",
    filename: buildCsvFilename(),
    writeHeader(target) {
      const header = includeBalance
        ? "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Tags,Running Balance"
        : "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Tags";
      target.write(`${header}\n`);
    },
    formatRow(row) {
      if (includeBalance) {
        const key = row.account_id ?? null;
        const next = (runningBalances.get(key) ?? toDecimal(0)).plus(
          toDecimal(row.amount ?? 0),
        );
        runningBalances.set(key, next);
        return `${buildCsvRow({ ...row, running_balance: next.toString() }, { includeBalance })}\n`;
      }
      return `${buildCsvRow(row)}\n`;
    },
    label: "CSV",
    query,
  });
}

/**
 * @param {ExpressResponse} res
 * @param {{ whereSql: string, params: any[], nextParamIdx: number, query?: ExportQuery }} args
 * @returns {Promise<{ rowCount: number }>}
 */
export async function streamNdjsonExport(
  res,
  { whereSql, params, nextParamIdx, query },
) {
  return streamExport(res, {
    whereSql,
    params,
    nextParamIdx,
    contentType: "application/x-ndjson",
    filename: buildNdjsonFilename(),
    formatRow(row) {
      return `${buildNdjsonRow(row)}\n`;
    },
    label: "JSON",
    query,
  });
}

/**
 * Helper used by the POST /bulk-export route: builds a WHERE clause that
 * targets a fixed list of ids while leaving the param numbering compatible
 * with the chunk-SQL builder (which appends LIMIT/OFFSET).
 *
 * @param {number[]} ids
 * @returns {{ whereSql: string, params: [number[]], nextParamIdx: number }}
 */
export function buildIdListWhere(ids) {
  return {
    whereSql: "t.id = ANY($1::int[])",
    params: [ids],
    nextParamIdx: 2,
  };
}
