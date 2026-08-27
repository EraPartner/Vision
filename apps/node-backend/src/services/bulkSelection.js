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
import { buildTransactionWhere, parseAmountFilter, validateInt4Ids } from '../lib/filterBuilder.js';
import {
  assertMaxLength,
  assertOptionalId,
  assertYmd,
  validateIntArray,
  validateNumber,
} from '../lib/validation.js';
import { EXPORT_JOINS_SQL } from './transactionExport.js';

const DEFAULT_ID_CAP = 500;
const DEFAULT_FILTER_CAP = 5000;

/**
 * Wire filter body accepted by the bulk-action endpoints. Deliberately a
 * dynamic property bag (`Record<string, any>`), not a fixed interface: it
 * accepts BOTH the camelCase shape used internally and the snake_case
 * query-string shape the frontend sends for the same field (see `pick`
 * below), so any given key may or may not be present under either name.
 * @typedef {Record<string, any>} BulkFilterInput
 */

/**
 * Every field the bulk filter understands, as `[camelCase, snake_case]` pairs.
 * Doubles as the accept-list: a key in neither column is rejected rather than
 * ignored (see `normalizeBulkFilter`). `tags` is the wire name of `tagSlugs` —
 * an alias pair like the rest, just not a case transform.
 */
const FILTER_ALIASES = [
  ['transactionId', 'transaction_id'],
  ['startDate', 'start_date'],
  ['endDate', 'end_date'],
  ['accountId', 'account_id'],
  ['bankAccount', 'bank_account'],
  ['bankAccounts', 'bank_accounts'],
  ['categoryId', 'category_id'],
  ['categoryIds', 'category_ids'],
  ['recipientId', 'recipient_id'],
  ['recipientGroupId', 'recipient_group_id'],
  ['recipientName', 'recipient_name'],
  ['search', 'search'],
  ['active', 'active'],
  ['transactionType', 'transaction_type'],
  ['amountMin', 'amount_min'],
  ['amountMax', 'amount_max'],
  ['amountSigned', 'amount_signed'],
  ['tagSlugs', 'tags'],
];

const KNOWN_FILTER_KEYS = new Set(FILTER_ALIASES.flat());

/**
 * "Absent" for a filter field: never sent, sent as JSON `null` (which is what a
 * `NaN` id serialises to on the frontend), or sent empty. All three mean "no
 * filter on this field" and answer 200 — the same unset convention
 * `assertOptionalId` and the list endpoint's query params use. Malformed is a
 * different case and is answered differently: `{}` is 400.
 * @param {unknown} value
 */
const isUnset = (value) => value === undefined || value === null || value === '';

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string|null}
 */
function optionalString(value, field) {
  if (isUnset(value)) return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string|null}
 */
function optionalYmd(value, field) {
  if (isUnset(value)) return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  return assertYmd(value, field);
}

/**
 * Booleans arrive either as real booleans (the frontend's `BulkTransactionFilter`)
 * or as the query-string spelling this normaliser also accepts. Anything else
 * used to collapse to the default silently — `active: 0` read as `active: true`.
 * @param {unknown} value
 * @param {string} field
 * @param {boolean} fallback
 * @returns {boolean}
 */
function optionalBoolean(value, field, fallback) {
  if (isUnset(value)) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError(`${field} must be a boolean`);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number|null}
 */
function optionalAmount(value, field) {
  if (isUnset(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new ValidationError(`${field} must be a number`);
  }
  const result = validateNumber(value, { fieldName: field });
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number[]|null}
 */
function optionalIdArray(value, field) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array of positive integers`);
  }
  if (value.length === 0) return null;
  const result = validateIntArray(value, field);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]|null}
 */
function optionalStringArray(value, field) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array of strings`);
  if (value.length === 0) return null;
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ValidationError(`${field} contains invalid value: ${entry}`);
    }
    return entry.trim();
  });
}

/**
 * Tag slugs accept an array (the frontend's shape) or the comma-separated
 * query-string spelling, exactly as before. An element that trims to nothing is
 * rejected rather than filtered out: `tags: 'rome-2020,'` is malformed, and
 * dropping it left a filter that matched more rows than the caller named.
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]|null}
 */
function optionalTagSlugs(value, field) {
  if (isUnset(value)) return null;
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((s) => s.trim().toLowerCase())
      : undefined;
  if (list === undefined) {
    throw new ValidationError(`${field} must be an array of strings or a comma-separated string`);
  }
  if (list.length === 0) return null;
  return list.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ValidationError(`${field} contains invalid value: ${entry}`);
    }
    return entry;
  });
}

/**
 * Coerce a wire filter object into the shape `buildTransactionWhere` expects.
 * Accepts both the camelCase shape used internally and the snake_case query-string
 * shape used by the frontend, so callers can forward request bodies as-is.
 *
 * Every field is validated, and a field that fails validation rejects the whole
 * request. That is the point, and it is a stronger rule than the list endpoint's
 * because the consequence is different. This filter also drives POST
 * /bulk-delete, so a field that failed a type guard and was then *skipped* did
 * not narrow the action, it widened it: `{category_ids: '5'}` — a string where
 * the array was expected — emitted no category clause at all, and the delete
 * swept every transaction the rest of the filter matched (capped at 5000),
 * answering 200 with a plausible count. The same shape was live on
 * `bank_accounts` (array guard), `tags`, `transaction_type` (value guard),
 * `amount_min`/`amount_max` (unparseable → clause dropped) and on any key the
 * normaliser did not recognise at all — `{account_ids: [7]}` reached the
 * builder as an empty filter, i.e. "every active transaction".
 *
 * So: unknown keys reject, wrong types reject, malformed values reject. Absent
 * and empty still mean "no filter on this field" and stay 200 (`[]`, `''`, and
 * the JSON `null` a frontend `NaN` id serialises to), which is what keeps the
 * "select all N matching" flow working — with no filters set it sends
 * `{active: true}`, a legitimate whole-table selection that the 5000-row cap,
 * not this function, is responsible for bounding.
 *
 * Two deliberate non-rejections, both narrowing rather than widening and both
 * shared verbatim with the list endpoint: a `search` shorter than
 * MIN_SEARCH_LENGTH is ignored by the builder, and `bankAccounts`/`tagSlugs`
 * are sliced to the builder's 50-element cap.
 * @param {BulkFilterInput} filter
 * @returns {object}
 * @throws {ValidationError} on an unknown key or any malformed field
 */
export function normalizeBulkFilter(filter) {
  if (!filter || typeof filter !== 'object') return {};
  if (Array.isArray(filter)) throw new ValidationError('`filter` must be an object');

  const unknown = Object.keys(filter).filter((key) => !KNOWN_FILTER_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ValidationError(`\`filter\` contains unknown field(s): ${unknown.join(', ')}`);
  }

  /**
   * Reads one field under either spelling. Both spellings present at once is
   * rejected rather than resolved by precedence: they are one field, and
   * silently keeping the camelCase value is the same silent-ignore shape as
   * everything else here.
   * @param {string} camel
   * @param {string} snake
   * @returns {any}
   */
  const pick = (camel, snake) => {
    if (camel === snake) return filter[camel];
    if (filter[camel] != null && filter[snake] != null) {
      throw new ValidationError(`Provide either \`${camel}\` or \`${snake}\`, not both`);
    }
    return filter[camel] ?? filter[snake];
  };

  const amountSigned = optionalBoolean(pick('amountSigned', 'amount_signed'), 'amount_signed', false);

  return {
    transactionId: assertOptionalId(pick('transactionId', 'transaction_id'), 'transaction_id'),
    startDate: optionalYmd(pick('startDate', 'start_date'), 'start_date'),
    endDate: optionalYmd(pick('endDate', 'end_date'), 'end_date'),
    accountId: assertOptionalId(pick('accountId', 'account_id'), 'account_id'),
    bankAccount: optionalString(pick('bankAccount', 'bank_account'), 'bank_account'),
    bankAccounts: optionalStringArray(pick('bankAccounts', 'bank_accounts'), 'bank_accounts'),
    categoryId: assertOptionalId(pick('categoryId', 'category_id'), 'category_id'),
    categoryIds: optionalIdArray(pick('categoryIds', 'category_ids'), 'category_ids'),
    recipientId: assertOptionalId(pick('recipientId', 'recipient_id'), 'recipient_id'),
    recipientGroupId: assertOptionalId(pick('recipientGroupId', 'recipient_group_id'), 'recipient_group_id'),
    recipientName: optionalString(pick('recipientName', 'recipient_name'), 'recipient_name'),
    // The list endpoint truncates an over-long search to 200 chars. Truncating
    // a substring match here would *widen* the delete, so this rejects instead.
    search: /** @type {string|null} */ (
      assertMaxLength(optionalString(pick('search', 'search'), 'search'), 200, 'search')
    ),
    active: optionalBoolean(pick('active', 'active'), 'active', true),
    transactionType: parseTransactionType(pick('transactionType', 'transaction_type')),
    amountMin: parseAmountFilter(optionalAmount(pick('amountMin', 'amount_min'), 'amount_min'), amountSigned),
    amountMax: parseAmountFilter(optionalAmount(pick('amountMax', 'amount_max'), 'amount_max'), amountSigned),
    amountSigned,
    tagSlugs: optionalTagSlugs(pick('tagSlugs', 'tags'), 'tags'),
  };
}

/**
 * @param {unknown} value
 * @returns {'income'|'expense'|null}
 */
function parseTransactionType(value) {
  if (isUnset(value)) return null;
  if (value !== 'income' && value !== 'expense') {
    throw new ValidationError("transaction_type must be 'income' or 'expense'");
  }
  return value;
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
    // No `.map(Number)` in front of the validator: it did not merely drop bad
    // entries, it retargeted them. Number('1e3') is 1000 and Number('0x10') is
    // 16, both of which then passed as ids, so a bulk DELETE could hard-delete
    // a row the client never named. Number([7]) is 7 and Number(true) is 1 for
    // the same reason. Each element is validated as sent instead.
    //
    // Rejecting rather than skipping is safe for a stale selection: staleness
    // is not what this filter catches. An id whose row was deleted in another
    // tab is still a valid integer — it passes validation and simply matches
    // nothing in the `id = ANY(...)` below. Only malformed input is rejected,
    // and the frontend holds `number[]` straight from the API.
    return validateInt4Ids(ids, 'ids');
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
  return idsResult.rows.map((/** @type {{ id: number }} */ row) => row.id);
}

export const BULK_SELECTION_DEFAULTS = Object.freeze({
  idCap: DEFAULT_ID_CAP,
  filterCap: DEFAULT_FILTER_CAP,
});
