/**
 * filterBuilder — centralized SQL WHERE/JOIN builders for transaction-like queries.
 *
 * Consolidates filter shapes previously duplicated across:
 *   - repositories/transactionRepository.ts  (buildWhereClause)
 *   - repositories/infoRepository.ts         (excludedCategoryIds / excludedRecipientIds
 *                                             + bankAccount/date predicates)
 *   - repositories/splitRepository.ts        (primary-recipient COALESCE pattern)
 *
 * Every builder returns Kysely `sql` fragments (ADR-226) whose values are bound
 * parameters, so callers compose them into larger templates without tracking
 * placeholder numbers.
 */

import { sql } from "kysely";
import type { RawBuilder } from "kysely";
import { validateIntArray } from "./validation.ts";
import { ValidationError } from "../middleware/errorHandler.ts";

const MAX_LIST_SIZE = 50;
// Free-text search terms shorter than this (after trimming) are ignored: a
// 1-character term matches nearly every row while still paying the full cost
// of the multi-branch scan below.
export const MIN_SEARCH_LENGTH = 2;

/**
 * Validate a list of PostgreSQL INT4 ids for use in a generated SQL clause.
 *
 * Rejects the whole list — it does NOT drop elements. Dropping was the bug: at
 * SQL-build time a discarded id does not 404, it silently changes which rows
 * the query covers. An exclusion list that loses an element quietly stops
 * excluding that category; one that loses every element emits no clause at all
 * and answers with the full dataset. A bulk selection that loses an element
 * writes to a smaller set than the caller named. Nothing surfaced either way.
 *
 * Delegates to validateIntArray (hence validateId), so the accepted element
 * shapes are exactly the `:id` params', the body arrays' and the aggregation
 * query params': a plain base-10 digit string or an integer number, 1..2^31-1.
 * That also fixes an off-by-one this filter used to carry on its own — it
 * bounded ids with `id < 2147483647`, so a legal int4 id at the ceiling was
 * accepted by every route-layer validator and then dropped here.
 *
 * Nullish input means "no ids" and yields `[]` (the unset convention
 * assertOptionalId and parseIdArrayQueryParam use); callers skip the clause.
 * @throws {ValidationError} when any element is not a valid int4 id
 */
export function validateInt4Ids(ids: unknown, fieldName = "ids"): number[] {
  if (ids === undefined || ids === null) return [];
  const result = validateIntArray(ids, fieldName);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

/**
 * Coerce one amount-filter value to a comparable number. Compares on magnitude
 * (|amount|) by default — income/expense sign belongs to transaction_type — or
 * on the signed amount when `signed` is true, so +50 and -50 are distinct.
 * Returns undefined for missing or unparseable input (the clause is skipped).
 *
 * Single source of truth for the list endpoint (routes/transactions.js) and
 * bulk selection (services/bulkSelection.js), which must stay in lockstep.
 */
export function parseAmountFilter(
  value: unknown,
  signed = false,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return signed ? n : Math.abs(n);
}

export interface TransactionWhereOptions {
  transactionId?: number | null | undefined;
  /** inclusive */
  startDate?: string | null | undefined;
  /** inclusive */
  endDate?: string | null | undefined;
  /**
   * exact match on t.account_id — the preferred account filter (ADR-088; the
   * bank_account string is being retired)
   */
  accountId?: number | null | undefined;
  /** multiple account ids (IN clause); ignored when accountId is set */
  accountIds?: number[] | null | undefined;
  /**
   * substring, ILIKE on the account's canonical name (accounts.name via
   * t.account_id — ADR-088 contract: the SQL no longer touches the retired
   * bank_account string) — legacy escape hatch; prefer accountId
   */
  bankAccount?: string | null | undefined;
  /**
   * exact match on accounts.name (resolved through t.account_id); ignored
   * when bankAccount is set; capped at MAX_LIST_SIZE
   */
  bankAccounts?: string[] | null | undefined;
  /** matches transaction, recipient-default or primary-default */
  categoryId?: number | null | undefined;
  /** multiple category IDs (IN clause); ignored when categoryId is set */
  categoryIds?: number[] | null | undefined;
  /** matches the txn recipient or any sub-recipient under it */
  recipientId?: number | null | undefined;
  /**
   * like recipientId but resolves the full primary group: includes the
   * recipient's own primary (if it is an alias) and all other aliases sharing
   * that primary
   */
  recipientGroupId?: number | null | undefined;
  /** substring, ILIKE on r.name */
  recipientName?: string | null | undefined;
  /**
   * multi-column substring (memo, comment, bank, currency, amount, recipients,
   * categories, date text and tag slugs); ignored when shorter than
   * MIN_SEARCH_LENGTH after trimming
   */
  search?: string | null | undefined;
  /** require t.is_active = true (default true) */
  active?: boolean | undefined;
  /** filter by amount sign */
  transactionType?: "income" | "expense" | null | undefined;
  /**
   * inclusive lower bound on the amount. By default compares |amount|
   * (magnitude, sign-agnostic); when amountSigned is true compares the signed
   * amount.
   */
  amountMin?: number | null | undefined;
  /** inclusive upper bound (see amountMin) */
  amountMax?: number | null | undefined;
  /**
   * when true, amountMin/amountMax are compared against the signed t.amount
   * (so -50/+50 are distinct); when false they compare against ABS(t.amount)
   */
  amountSigned?: boolean | undefined;
  /** OR-match: row must have at least one of these active tags */
  tagSlugs?: string[] | null | undefined;
}

/**
 * Build the canonical transaction WHERE clause.
 *
 * Assumes the caller joined `transactions t` with:
 *   LEFT JOIN recipients r ON t.recipient_id = r.id
 *
 * `r` is the ONLY join alias any predicate built here references, and only the
 * `recipientName` filter references it (`r.name ILIKE`). Every other filter
 * resolves against `t` plus self-contained subqueries, so a caller that needs
 * no projection (a count) may join `r` alone — see the reduced join set used by
 * transactionRepository's uncategorised total. Callers that also project
 * recipient/category/account labels still join `pr`/`c`/`rc`/`pc`/`acct`, but
 * this builder does not require them.
 */
export function buildTransactionWhere(
  opts: TransactionWhereOptions = {},
): RawBuilder<unknown> {
  const {
    transactionId = null,
    startDate = null,
    endDate = null,
    accountId = null,
    accountIds = null,
    bankAccount = null,
    bankAccounts = null,
    categoryId = null,
    categoryIds = null,
    recipientId = null,
    recipientGroupId = null,
    recipientName = null,
    search = null,
    active = true,
    transactionType = null,
    amountMin = null,
    amountMax = null,
    amountSigned = false,
    tagSlugs = null,
  } = opts;

  const clauses: RawBuilder<unknown>[] = [sql`1=1`];

  if (active) clauses.push(sql`t.is_active = true`);

  if (transactionId != null) {
    clauses.push(sql`t.id = ${transactionId}`);
  }
  if (startDate) {
    clauses.push(sql`t.date >= ${startDate}`);
  }
  if (endDate) {
    clauses.push(sql`t.date <= ${endDate}`);
  }
  if (accountId != null) {
    clauses.push(sql`t.account_id = ${accountId}`);
  } else if (Array.isArray(accountIds) && accountIds.length > 0) {
    const safe = validateInt4Ids(accountIds, "accountIds");
    if (safe.length > 0) {
      clauses.push(sql`t.account_id IN (${sql.join(safe)})`);
    }
  }
  // Both bank filters resolve through account_id (ADR-088 contract phase): the
  // label lives on accounts.name, and rows are matched by FK — never by the
  // retired transactions.bank_account string. Under the dual-write parity
  // invariant (trigger 0051/0083 + rename propagation) the observable matches
  // are identical to the old string predicates.
  if (bankAccount) {
    clauses.push(
      sql`t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name ILIKE ${`%${bankAccount}%`})`,
    );
  } else if (Array.isArray(bankAccounts) && bankAccounts.length > 0) {
    const safe = bankAccounts
      .slice(0, MAX_LIST_SIZE)
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (safe.length > 0) {
      clauses.push(
        sql`t.account_id IN (SELECT fa.id FROM accounts fa WHERE fa.name IN (${sql.join(safe)}))`,
      );
    }
  }
  if (categoryId != null) {
    // Effective-category match, expanded from COALESCE(t.category_id,
    // r.default_category_id, pr.default_category_id) into an indexable
    // disjunction of semi-joins so the planner can use the category_id indexes.
    // Replicates the COALESCE precedence exactly:
    //   own category = X, OR
    //   (own NULL AND recipient default = X), OR
    //   (own NULL AND recipient default NULL AND primary default = X).
    clauses.push(
      effectiveCategoryIn(
        sql`(SELECT category_id FROM category_ancestors WHERE ancestor_id = ${categoryId})`,
      ),
    );
  } else if (Array.isArray(categoryIds) && categoryIds.length > 0) {
    const safe = validateInt4Ids(categoryIds, "categoryIds");
    if (safe.length > 0) {
      // Same effective-category expansion as the single-value branch above,
      // with each leaf comparing against the id list.
      clauses.push(
        effectiveCategoryIn(
          sql`(SELECT category_id FROM category_ancestors WHERE ancestor_id IN (${sql.join(safe)}))`,
        ),
      );
    }
  }
  if (transactionType === "income") {
    clauses.push(sql`t.amount > 0`);
  } else if (transactionType === "expense") {
    clauses.push(sql`t.amount < 0`);
  }
  const amountCol = amountSigned ? sql`t.amount` : sql`ABS(t.amount)`;
  if (amountMin != null && Number.isFinite(Number(amountMin))) {
    clauses.push(sql`${amountCol} >= ${Number(amountMin)}`);
  }
  if (amountMax != null && Number.isFinite(Number(amountMax))) {
    clauses.push(sql`${amountCol} <= ${Number(amountMax)}`);
  }
  if (recipientId != null) {
    // Semi-join so the planner can use the t.recipient_id index instead of an
    // OR spanning t and the joined recipients r. Equivalent to
    // (t.recipient_id = $ OR r.primary_recipient_id = $): the subquery returns
    // the recipient itself plus every alias whose primary is it.
    clauses.push(
      sql`t.recipient_id IN (SELECT id FROM recipients WHERE id = ${recipientId} OR primary_recipient_id = ${recipientId})`,
    );
  }
  if (recipientGroupId != null) {
    // Resolve the full primary group: match the recipient itself, any aliases under it,
    // the recipient's own primary (if it is an alias), and siblings under that primary.
    // The two subqueries return NULL when the recipient has no primary, making those
    // branches no-ops (NULL = anything is false in SQL).
    //
    // Shaped as a semi-join for the same reason as recipientId above: the four
    // branches used to OR `t.recipient_id` against the joined `r.primary_recipient_id`,
    // so the predicate spanned two relations and the planner could only evaluate it as
    // a join Filter — no BitmapOr, no Index Cond on idx_transactions_recipient_id.
    // Every branch resolves inside `recipients` here, leaving `t.recipient_id` as the
    // only transactions-side column. The branch set is unchanged: `r` is joined on
    // `t.recipient_id = r.id`, so `r.primary_recipient_id` for a row is exactly the
    // `primary_recipient_id` of the recipient whose id equals `t.recipient_id`.
    const g = recipientGroupId;
    clauses.push(sql`t.recipient_id IN (
      SELECT id FROM recipients
      WHERE id = ${g}
         OR primary_recipient_id = ${g}
         OR id = (SELECT primary_recipient_id FROM recipients WHERE id = ${g} AND primary_recipient_id IS NOT NULL)
         OR primary_recipient_id = (SELECT primary_recipient_id FROM recipients WHERE id = ${g} AND primary_recipient_id IS NOT NULL)
    )`);
  }
  if (recipientName) {
    clauses.push(sql`r.name ILIKE ${`%${recipientName}%`}`);
  }
  const searchText = search == null ? "" : String(search);
  if (searchText.trim().length >= MIN_SEARCH_LENGTH) {
    // Free-text search spans every user-visible facet of a transaction: notes,
    // bank/currency, amount, recipients, categories, the date (as ISO text so
    // "2026-06" matches), and any of the row's active tag slugs.
    //
    // Shaped as `t.id IN (UNION of per-relation branches)` rather than one OR
    // chain over the outer LEFT-JOIN aliases: the planner cannot push an OR
    // that spans joined relations down to any single scan, so the old shape
    // seq-scanned transactions plus all five joins plus per-row amount/date
    // casts and a per-row tag probe on every keystroke. Each branch here is a
    // self-contained scan the planner can index (pg_trgm on memo/comment and
    // recipients.name, btree on the id hops), and the CAST branches exist only
    // when the term is made of characters the cast text can actually contain.
    const term = `%${searchText}%`;
    const matchingCategories = sql`SELECT sc.id FROM categories sc WHERE sc.path_name ILIKE ${term} OR sc.general ILIKE ${term} OR sc.detail ILIKE ${term}`;
    const branches: RawBuilder<unknown>[] = [
      sql`SELECT st.id FROM transactions st WHERE st.memo ILIKE ${term} OR st.comment ILIKE ${term}`,
      // Bank label via the account entity (ADR-088): the search must match the
      // canonical accounts.name through the FK, not the retired string column.
      sql`SELECT st.id FROM transactions st WHERE st.account_id IN (SELECT sa.id FROM accounts sa WHERE sa.name ILIKE ${term})`,
      sql`SELECT st.id FROM transactions st WHERE st.currency ILIKE ${term}`,
    ];
    if (/^[0-9.-]+$/.test(searchText)) {
      branches.push(
        sql`SELECT st.id FROM transactions st WHERE CAST(st.amount AS TEXT) ILIKE ${term}`,
      );
    }
    if (/^[0-9-]+$/.test(searchText)) {
      branches.push(
        sql`SELECT st.id FROM transactions st WHERE CAST(st.date AS TEXT) ILIKE ${term}`,
      );
    }
    branches.push(
      // Recipient name — the transaction's own recipient (r.name) or the
      // primary it aliases (pr.name).
      sql`SELECT st.id FROM transactions st WHERE st.recipient_id IN (
        SELECT sr.id FROM recipients sr WHERE sr.name ILIKE ${term}
        UNION
        SELECT sr.id FROM recipients sr WHERE sr.primary_recipient_id IN (
          SELECT srp.id FROM recipients srp WHERE srp.name ILIKE ${term}
        )
      )`,
      // Categories — the transaction's own (c), the recipient's default (rc),
      // and the primary recipient's default (pc).
      sql`SELECT st.id FROM transactions st WHERE st.category_id IN (${matchingCategories})`,
      sql`SELECT st.id FROM transactions st WHERE st.recipient_id IN (
        SELECT sr.id FROM recipients sr WHERE sr.default_category_id IN (${matchingCategories})
        UNION
        SELECT sr.id FROM recipients sr WHERE sr.primary_recipient_id IN (
          SELECT srp.id FROM recipients srp WHERE srp.default_category_id IN (${matchingCategories})
        )
      )`,
      // Active tag slugs via the junction table.
      sql`SELECT tt.transaction_id FROM transaction_tags tt
        JOIN tags tg ON tg.id = tt.tag_id
        WHERE tg.is_active = true AND tg.slug ILIKE ${term}`,
    );
    clauses.push(sql`t.id IN (${sql.join(branches, sql` UNION `)})`);
  }
  if (Array.isArray(tagSlugs) && tagSlugs.length > 0) {
    const safe = tagSlugs
      .slice(0, MAX_LIST_SIZE)
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (safe.length > 0) {
      clauses.push(sql`EXISTS (
        SELECT 1 FROM transaction_tags tt
        JOIN tags tg ON tg.id = tt.tag_id
        WHERE tt.transaction_id = t.id
          AND tg.slug = ANY(${safe}::text[])
          AND tg.is_active = true
      )`);
    }
  }

  return sql.join(clauses, sql` AND `);
}

/**
 * The effective-category disjunction: own category, else the recipient's
 * default, else the primary recipient's default, in `descendants`.
 */
function effectiveCategoryIn(
  descendants: RawBuilder<unknown>,
): RawBuilder<unknown> {
  return sql`(
      t.category_id IN ${descendants}
      OR (t.category_id IS NULL AND t.recipient_id IN (SELECT id FROM recipients WHERE default_category_id IN ${descendants}))
      OR (t.category_id IS NULL AND t.recipient_id IN (
        SELECT r2.id FROM recipients r2
        JOIN recipients pr2 ON r2.primary_recipient_id = pr2.id
        WHERE r2.default_category_id IS NULL AND pr2.default_category_id IN ${descendants}
      ))
    )`;
}

// ── Exclusion predicates ───────────────────────────────────────────────────

/**
 * The r/pr joins that {@link exclusionClauses}' predicates reference:
 * `transactions t` → recipient `r` → primary recipient `pr`.
 */
export const EXCLUSION_JOINS = sql`LEFT JOIN recipients r ON t.recipient_id = r.id
LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id`;

export interface ExclusionSql {
  /** {@link EXCLUSION_JOINS} when a predicate exists, otherwise empty. */
  joins: RawBuilder<unknown>;
  /** `AND <predicates>`, or empty when no valid exclusions were supplied. */
  where: RawBuilder<unknown>;
  /** True when at least one predicate was emitted. */
  active: boolean;
}

/**
 * Exclusion predicates used by dashboard/info aggregation queries.
 *
 * Honors primary-recipient aggregation: excluding a primary recipient also excludes
 * all of its sub-recipients, and excluding a category also excludes transactions
 * whose effective category (explicit → recipient default → primary default)
 * matches it or any of its descendants. Predicates reference `t`, `r` and `pr`
 * (see {@link EXCLUSION_JOINS}).
 * @throws {ValidationError} when an id is not a valid int4
 */
export function exclusionClauses({
  excludedCategoryIds = [],
  excludedRecipientIds = [],
}: {
  excludedCategoryIds?: readonly unknown[] | undefined;
  excludedRecipientIds?: readonly unknown[] | undefined;
}): ExclusionSql {
  const safeCats = validateInt4Ids(excludedCategoryIds, "excludedCategoryIds");
  const safeRecs = validateInt4Ids(
    excludedRecipientIds,
    "excludedRecipientIds",
  );
  const clauses: RawBuilder<unknown>[] = [];

  // A selected category excludes its direct assignments and every descendant.
  // NOT EXISTS keeps uncategorized rows, unlike a nullable NOT IN predicate.
  if (safeCats.length > 0) {
    clauses.push(sql`NOT EXISTS (SELECT 1 FROM category_ancestors excluded
        WHERE excluded.category_id = COALESCE(t.category_id, r.default_category_id, pr.default_category_id)
          AND excluded.ancestor_id IN (${sql.join(safeCats)}))`);
  }
  // The trailing -1 keeps recipient-less rows when a recipient exclusion is
  // present: NULL NOT IN would otherwise drop them.
  if (safeRecs.length > 0) {
    clauses.push(
      sql`COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN (${sql.join(safeRecs)})`,
    );
  }

  const active = clauses.length > 0;
  return {
    joins: active ? EXCLUSION_JOINS : sql``,
    where: andClauses(clauses),
    active,
  };
}

/** `AND a AND b ...`, or an empty fragment for no clauses. */
export function andClauses(
  clauses: readonly RawBuilder<unknown>[],
): RawBuilder<unknown> {
  return clauses.length > 0 ? sql`AND ${sql.join(clauses, sql` AND `)}` : sql``;
}
