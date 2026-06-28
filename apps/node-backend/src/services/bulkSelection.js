/**
 * bulkSelection — shared resolver for `{ ids } | { filter }` request bodies used
 * by the bulk-action endpoints (`/bulk-delete`, `/bulk-update`, `/bulk-export`).
 *
 * Returns the concrete list of transaction IDs the action should target. Callers
 * then run their write or read inside `withTransaction(...)` against that list.
 *
 * The filter shape mirrors the GET /api/transactions list filters and is fed
 * through `buildTransactionWhere` so behaviour stays in lockstep with the list
 * endpoint. A COUNT(*) precheck enforces a hard upper bound (default 5000) on
 * filter-mode requests so a mistyped filter cannot delete the whole table.
 */

import { query as dbQuery } from '../database/connection.js';
import { ValidationError } from '../middleware/errorHandler.js';
import { buildTransactionWhere, validateInt4Ids } from './filterBuilder.js';
import { EXPORT_JOINS_SQL } from './transactionExport.js';

const DEFAULT_ID_CAP = 500;
const DEFAULT_FILTER_CAP = 5000;

/**
 * Coerce a wire filter object into the shape `buildTransactionWhere` expects.
 * Accepts both the camelCase shape used internally and the snake_case query-string
 * shape used by the frontend, so callers can forward request bodies as-is.
 */
export function normalizeBulkFilter(filter) {
  if (!filter || typeof filter !== 'object') return {};

  const pick = (camel, snake) => filter[camel] ?? filter[snake] ?? null;

  const tagSlugs = Array.isArray(filter.tagSlugs)
    ? filter.tagSlugs
    : Array.isArray(filter.tags)
      ? filter.tags
      : typeof filter.tags === 'string' && filter.tags.length > 0
        ? filter.tags.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        : null;

  const categoryIds = Array.isArray(filter.categoryIds)
    ? filter.categoryIds
    : Array.isArray(filter.category_ids)
      ? filter.category_ids
      : null;

  const toAmount = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Math.abs(Number(v));
    return Number.isFinite(n) ? n : null;
  };

  return {
    transactionId: pick('transactionId', 'transaction_id'),
    startDate: pick('startDate', 'start_date'),
    endDate: pick('endDate', 'end_date'),
    bankAccount: pick('bankAccount', 'bank_account'),
    bankAccounts: filter.bankAccounts ?? filter.bank_accounts ?? null,
    categoryId: pick('categoryId', 'category_id'),
    categoryIds: categoryIds && categoryIds.length > 0 ? categoryIds : null,
    recipientId: pick('recipientId', 'recipient_id'),
    recipientGroupId: pick('recipientGroupId', 'recipient_group_id'),
    recipientName: pick('recipientName', 'recipient_name'),
    search: filter.search ?? null,
    active: filter.active !== false,
    transactionType:
      filter.transactionType === 'income' ||
      filter.transactionType === 'expense' ||
      filter.transaction_type === 'income' ||
      filter.transaction_type === 'expense'
        ? filter.transactionType ?? filter.transaction_type
        : null,
    amountMin: toAmount(filter.amountMin ?? filter.amount_min),
    amountMax: toAmount(filter.amountMax ?? filter.amount_max),
    tagSlugs,
  };
}

/**
 * Resolve a `{ ids } | { filter }` selector into a concrete `number[]` of
 * transaction IDs. Throws `ValidationError` on every malformed or oversized input.
 *
 * @param {object} selector
 * @param {number[]} [selector.ids]
 * @param {object} [selector.filter]
 * @param {object} [opts]
 * @param {number} [opts.idCap=500]      Maximum length for explicit id arrays
 * @param {number} [opts.filterCap=5000] Maximum row count for filter-mode
 * @returns {Promise<number[]>}
 */
export async function resolveBulkSelection(selector = {}, opts = {}) {
  const { ids, filter } = selector;
  const idCap = opts.idCap ?? DEFAULT_ID_CAP;
  const filterCap = opts.filterCap ?? DEFAULT_FILTER_CAP;

  const hasIds = Array.isArray(ids) && ids.length > 0;
  const hasFilter = filter && typeof filter === 'object' && Object.keys(filter).length > 0;

  if (hasIds && hasFilter) {
    throw new ValidationError('Provide either `ids` or `filter`, not both');
  }
  if (!hasIds && !hasFilter) {
    throw new ValidationError('Either `ids` or `filter` must be provided');
  }

  if (hasIds) {
    if (!Array.isArray(ids)) {
      throw new ValidationError('`ids` must be an array of integers');
    }
    if (ids.length > idCap) {
      throw new ValidationError(`\`ids\` must contain at most ${idCap} entries (received ${ids.length})`);
    }
    const safe = validateInt4Ids(ids.map(Number));
    if (safe.length === 0) {
      throw new ValidationError('`ids` contains no valid integer IDs');
    }
    return safe;
  }

  const normalized = normalizeBulkFilter(filter);
  const { sql: whereSql, params } = buildTransactionWhere(normalized);

  const countResult = await dbQuery(
    `SELECT COUNT(*)::int AS n ${EXPORT_JOINS_SQL} WHERE ${whereSql}`,
    params,
  );
  const matched = countResult.rows[0]?.n ?? 0;

  if (matched === 0) {
    throw new ValidationError('Filter matches no transactions');
  }
  if (matched > filterCap) {
    throw new ValidationError(`Filter matches ${matched} transactions; cap is ${filterCap}`);
  }

  const idsResult = await dbQuery(
    `SELECT t.id ${EXPORT_JOINS_SQL} WHERE ${whereSql} ORDER BY t.id`,
    params,
  );
  return idsResult.rows.map((row) => row.id);
}

export const BULK_SELECTION_DEFAULTS = Object.freeze({
  idCap: DEFAULT_ID_CAP,
  filterCap: DEFAULT_FILTER_CAP,
});
