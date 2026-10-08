/**
 * transactionExport — shared streaming CSV / NDJSON pipeline used by the
 * `GET /api/transactions/export/csv|json` routes and the `POST /bulk-export`
 * route. Keeps the filename, header, chunk SQL, and column projection in one
 * place so the two entry points cannot drift.
 */

import { getClient, query as dbQuery } from "../database/connection.ts";
import { logger } from "../config/logger.ts";
import { NotFoundError } from "../middleware/errorHandler.ts";
import { toDecimal } from "../lib/money.ts";
import { toYmd } from "./calculations/portfolioMath.ts";
import { escapeCsvValue } from "../lib/csv.ts";
import { buildTransactionWhere } from "../lib/filterBuilder.ts";
import type { TransactionWhereOptions } from "../lib/filterBuilder.ts";
import {
  resolveBulkSelection,
  validateBulkSelection,
} from "./bulkSelection.ts";
import type { BulkFilterInput } from "./bulkSelection.ts";
import type { ExpressResponse } from "../types/express.ts";
import type Decimal from "decimal.js";

/**
 * Query runner for the export pipeline; the default is the pooled `query`,
 * the bulk export passes its snapshot client. Rows are cast to
 * `ExportTransactionRow` at the read site.
 */
export type ExportQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>;

/** An explicit WHERE model, as `buildIdListWhere` produces. */
interface ExportWhere {
  whereSql: string;
  params: unknown[];
  nextParamIdx: number;
}

/**
 * Either the route's validated filter model or the legacy explicit WHERE
 * shape (see `resolveExportWhere`).
 */
interface ExportWhereArgs {
  filters?: TransactionWhereOptions;
  whereSql?: string;
  params?: unknown[];
  nextParamIdx?: number;
}

/**
 * A row as selected by `buildExportChunkSql` — a projection of
 * `EnrichedTransactionRow`, not the full row (no `is_active`, `recipient_id`,
 * etc. — only the columns the export needs).
 */
export interface ExportTransactionRow {
  id: number;
  /** DATE — local-midnight `Date`; read via `toYmd`, never `String()`/`toISOString()`. */
  date: Date;
  bank_account: string | null;
  account_id?: number | null;
  recipient_name: string | null;
  memo: string | null;
  /** NUMERIC(18,4) — pg emits NUMERIC as a string. */
  amount: string;
  currency: string | null;
  /** NUMERIC(18,4) since migration 0088 — pg emits NUMERIC as a string; null on manual rows. */
  balance: string | null;
  /** '' when the transaction has no resolved category. */
  category_name: string;
  comment: string | null;
  /** tag slugs, `{}` (empty array) when none. */
  tags: string[];
}

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

function buildExportProbeSql(whereSql: string): string {
  return `SELECT 1 ${EXPORT_JOINS_SQL} WHERE ${whereSql} LIMIT 1`;
}

/**
 * Write a chunk to the response, respecting backpressure. When the socket
 * buffer is full `res.write` returns false — without this a slow client lets
 * rows buffer unboundedly in memory on a large export.
 */
function writeWithBackpressure(
  res: ExpressResponse,
  chunk: string,
): Promise<void> {
  // `res.once` is missing on minimal/mocked response objects — in that case
  // there's no drain event to await, so just resolve.
  const once = res.once;
  if (res.write(chunk) || typeof once !== "function") return Promise.resolve();
  return new Promise((resolve) => once.call(res, "drain", resolve));
}

function buildExportChunkSql(
  whereSql: string,
  limitParamIdx: number,
  cursorDateParamIdx?: number,
  cursorIdParamIdx?: number,
): string {
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
             WHEN c.id IS NOT NULL THEN c.path_name
             WHEN rc.id IS NOT NULL THEN rc.path_name
             WHEN pc.id IS NOT NULL THEN pc.path_name
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

function buildCsvRow(
  row: ExportTransactionRow & { running_balance?: string },
  { includeBalance = false }: { includeBalance?: boolean } = {},
): string {
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

function buildNdjsonRow(row: ExportTransactionRow): string {
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
 */
async function streamExport(
  res: ExpressResponse,
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
  }: ExportWhere & {
    contentType: string;
    filename: string;
    writeHeader?: (res: ExpressResponse) => void;
    formatRow: (row: ExportTransactionRow, rowIndex: number) => string;
    label: string;
    query?: ExportQuery;
  },
): Promise<{ rowCount: number }> {
  const probe = await query(buildExportProbeSql(whereSql), params);
  if (probe.rows.length === 0) {
    throw new NotFoundError("No transactions found matching filters");
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

  if (writeHeader) writeHeader(res);

  // Keyset cursor (last streamed (date, id)). First chunk has no cursor.
  let cursorDate: string | null = null;
  let cursorId: number | null = null;
  let rowCount = 0;
  try {
    while (true) {
      const chunk: { rows: unknown[] } =
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
      const rows = chunk.rows as ExportTransactionRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        await writeWithBackpressure(res, formatRow(row, rowCount));
        rowCount++;
      }
      const last = rows[rows.length - 1];
      // toYmd recovers the local calendar day from pg's local-midnight Date so
      // the ::date cursor never shifts a day in a UTC+ zone.
      cursorDate = toYmd(last.date);
      cursorId = last.id;
      if (rows.length < EXPORT_CHUNK_SIZE) break;
    }
    res.end();
    return { rowCount };
  } catch (err) {
    if (res.headersSent) {
      logger.error(`${label} export failed mid-stream`, {
        error: (err as Error).message,
      });
      if (res.destroy) res.destroy(err as Error);
      else res.end();
      throw err;
    }
    throw err;
  }
}

/**
 * Convert the route's validated filter model into the SQL fragment used by
 * both export formats. The legacy explicit WHERE shape remains accepted for
 * focused service tests and the bulk-id helper.
 */
function resolveExportWhere(args: ExportWhereArgs): ExportWhere {
  if (args.filters) {
    const { sql, params, nextParamIdx } = buildTransactionWhere(args.filters);
    return { whereSql: sql, params, nextParamIdx };
  }
  if (typeof args.whereSql !== "string" || !args.nextParamIdx) {
    throw new TypeError(
      "Export filters or an explicit WHERE model are required",
    );
  }
  return {
    whereSql: args.whereSql,
    params: args.params ?? [],
    nextParamIdx: args.nextParamIdx,
  };
}

export async function streamCsvExport(
  res: ExpressResponse,
  args: ExportWhereArgs & { includeBalance?: boolean; query?: ExportQuery },
): Promise<{ rowCount: number }> {
  const { includeBalance = false, query } = args;
  const { whereSql, params, nextParamIdx } = resolveExportWhere(args);
  // Partitioned by account_id (ADR-088): the list endpoint's window partitions
  // by account because a stream spanning multiple accounts otherwise sums them
  // into one meaningless cross-account total. Kept as Decimals across the whole
  // stream — collapsing to a JS number each row re-ingested a drifted float
  // into the next step's running balance.
  const runningBalances = new Map<number | null, Decimal>();
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

export async function streamNdjsonExport(
  res: ExpressResponse,
  args: ExportWhereArgs & { query?: ExportQuery },
): Promise<{ rowCount: number }> {
  const { query } = args;
  const { whereSql, params, nextParamIdx } = resolveExportWhere(args);
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
 */
function buildIdListWhere(ids: number[]): {
  whereSql: string;
  params: [number[]];
  nextParamIdx: number;
} {
  return {
    whereSql: "t.id = ANY($1::int[])",
    params: [ids],
    nextParamIdx: 2,
  };
}

/**
 * Resolve and stream one bulk export inside a repeatable-read snapshot. The
 * route owns request validation only; the database transaction belongs at the
 * service boundary with the selection and streaming orchestration (ADR-067).
 */
export async function streamBulkTransactionExport(
  res: ExpressResponse,
  {
    ids,
    filter,
    format,
    includeBalance = false,
  }: {
    ids?: number[];
    filter?: BulkFilterInput | null;
    format: "csv" | "json";
    includeBalance?: boolean;
  },
): Promise<void> {
  // Reject malformed selectors before reserving a pool connection. The same
  // shared validator is used again by resolveBulkSelection inside the snapshot,
  // so validation behavior cannot drift between export and the other actions.
  validateBulkSelection({ ids, filter });
  const client = await getClient();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const query: ExportQuery = (sql, params) => client.query(sql, params);
    const txIds = await resolveBulkSelection({ ids, filter }, { query });
    const countResult = await query(
      "SELECT COUNT(*)::int AS n FROM transactions WHERE id = ANY($1::int[])",
      [txIds],
    );
    const countRow = countResult.rows[0] as { n: number } | undefined;
    res.setHeader("X-Exported-Count", String(countRow?.n ?? 0));
    const where = buildIdListWhere(txIds);

    if (format === "csv") {
      await streamCsvExport(res, {
        ...where,
        includeBalance,
        query,
      });
    } else {
      await streamNdjsonExport(res, { ...where, query });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export { buildIdListWhere as __buildIdListWhere };
