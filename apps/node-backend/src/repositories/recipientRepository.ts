/**
 * Recipient Repository - data access for recipients table.
 *
 *
 * Performance notes:
 * - textNormalization is imported at module level to avoid per-call dynamic import overhead.
 * - createOrGet reads established rows without writing, then inserts on a miss
 *   inside a transaction so concurrent creators both resolve the winning row.
 * - getAll + getCount share the same WHERE predicate but are kept separate for clarity.
 *   Callers that need both can call them concurrently via Promise.all.
 */

import { sql } from "kysely";
import type { RawBuilder } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  countRowSchema,
  recipientKeyRowSchema,
} from "../database/rowSchemas.ts";
import {
  enrichedRecipientRowSchema,
  recipientAliasRowSchema,
  recipientClusterRootRowSchema,
  recipientMergeLockRowSchema,
  recipientRowSchema,
  requireRow,
} from "../database/rows/catalog.ts";
import { withTransaction } from "../database/connection.ts";
import type { RecipientAliasRow } from "../database/rows/catalog.ts";
import { normalizeForMatching } from "../lib/textNormalization.ts";
import { makeValidationError } from "../lib/repositoryErrors.ts";
import type { EnrichedRecipientRow, RecipientRow } from "../types/rows.ts";
import type { CategoryId, RecipientId } from "@vision/types/brands";

/**
 * Display name of the shared recipient that owns server-generated ledger rows
 * (`transfer_source` 'opening' / 'adjustment'). `transactions.recipient_id` is
 * NOT NULL (migration 0001) and no row may name a real payee it never paid, so
 * those rows point here instead. Stable — the row is resolved by normalized
 * name, so renaming this constant would orphan the existing one.
 */
const SYSTEM_RECIPIENT_NAME = "SYSTEM";

export type { RecipientRow, EnrichedRecipientRow };

/** Filters shared by getAll / getCount. */
export interface RecipientFilters {
  limit?: number | undefined;
  offset?: number | undefined;
  name?: string | null | undefined;
  defaultCategoryId?: CategoryId | null | undefined;
  search?: string | null | undefined;
  active?: boolean | undefined;
  uncategorized?: boolean | undefined;
  sortBy?: string | null | undefined;
  sortDir?: "asc" | "desc" | null | undefined;
}

// Allowed sort columns for recipients (maps frontend key -> SQL expression)
const RECIPIENT_SORT_COLUMNS: Record<string, RawBuilder<unknown>> = {
  name: sql`r.name`,
  default_category_name: sql`CASE WHEN c.id IS NOT NULL THEN c.path_name ELSE NULL END`,
  primary_bank_account: sql`primary_bank_account`,
  alias_count: sql`alias_count`,
  notes: sql`r.notes`,
  is_active: sql`r.is_active`,
};

/**
 * The enriched recipient projection over `recipients` (aliased `r`): the
 * default category path, primary bank account, primary name and alias count.
 */
const ENRICHED_RECIPIENTS = sql`
      SELECT r.*,
             CASE WHEN c.id IS NOT NULL THEN c.path_name ELSE NULL END AS default_category_name,
             (
               SELECT rba.account_number
               FROM recipient_bank_accounts rba
               WHERE rba.recipient_id = r.id AND rba.is_active = true
               ORDER BY rba.is_primary DESC
               LIMIT 1
             ) AS primary_bank_account,
             pr.name AS primary_recipient_name,
             COALESCE(ac.alias_count, 0) AS alias_count
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN (
        SELECT primary_recipient_id, count(*) AS alias_count
        FROM recipients
        WHERE primary_recipient_id IS NOT NULL
        GROUP BY primary_recipient_id
      ) ac ON ac.primary_recipient_id = r.id`;

/**
 * Code points grouped by their lower-case form, for the Unicode ILIKE below.
 * Built on first use: one pass over the code space (about 0.1 s).
 */
let lowerCaseGroups: Map<string, string[]> | null = null;

function caseGroups(): Map<string, string[]> {
  if (lowerCaseGroups) return lowerCaseGroups;
  const groups = new Map<string, string[]>();
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    const lower = ch.toLowerCase();
    if (lower === ch) continue;
    const group = groups.get(lower);
    if (group) group.push(ch);
    else groups.set(lower, [ch]);
  }
  // PostgreSQL lowers a word-final capital sigma to the final form, so a
  // stored 'ΟΔΟΣ' matches 'οδος'. A per-character class cannot see word
  // boundaries; treat the three sigmas as one letter instead.
  groups.set("σ", ["Σ", "ς"]);
  groups.set("ς", ["Σ", "σ"]);
  lowerCaseGroups = groups;
  return groups;
}

/** One code point as a PostgreSQL ARE escape (`\uXXXX` / `\UXXXXXXXX`). */
function areEscape(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  return cp <= 0xffff
    ? `\\u${cp.toString(16).padStart(4, "0")}`
    : `\\U${cp.toString(16).padStart(8, "0")}`;
}

/** The ARE fragment matching every character that lowers like `ch`. */
function caseInsensitiveChar(ch: string): string {
  const lower = ch.toLowerCase();
  const others = (caseGroups().get(lower) ?? []).filter((c) => c !== lower);
  const lowerChars = Array.from(lower);
  if (lowerChars.length > 1) {
    // Only U+0130 lowers to two code points ('i' + U+0307).
    const sequence = lowerChars.map(caseInsensitiveChar).join("");
    return `(?:${sequence}|${others.map(areEscape).join("|")})`;
  }
  if (others.length === 0) return areEscape(lower);
  return `[${[lower, ...others].map(areEscape).join("")}]`;
}

/**
 * The regular expression (PostgreSQL ARE, for SQLite's `REGEXP`) that matches
 * exactly the values `value ILIKE likePattern` matched under PostgreSQL's
 * `pg_unicode_fast` collation, which lowers both sides with Unicode case
 * mapping before a LIKE match: `%` is any run, `_` one character and `\`
 * makes the next character literal. Vision's `ilike()` keeps the C locale's
 * ASCII-only folding, so recipient search cannot use it.
 *
 * Known differences, both from context-dependent lower-casing: the three
 * sigmas are one letter (PostgreSQL picks the final form at a word end), and
 * a stored U+0130 ('İ') lowers to two characters in PostgreSQL, so there a
 * pattern 'i%' or '_' could match half of it.
 */
function unicodeIlikeRegex(likePattern: string): string {
  const chars = Array.from(likePattern);
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? "";
    if (c === "%") parts.push(".*");
    else if (c === "_") parts.push(".");
    else if (c === "\\" && i + 1 < chars.length) parts.push(caseInsensitiveChar(chars[++i] ?? ""));
    else parts.push(caseInsensitiveChar(c));
  }
  // A leading or trailing `%` is an unanchored end.
  const anchoredStart = parts[0] !== ".*";
  const anchoredEnd = parts.at(-1) !== ".*" || parts.length === 1;
  const body = parts.slice(anchoredStart ? 0 : 1, anchoredEnd ? parts.length : -1).join("");
  return `${anchoredStart ? "^" : ""}${body}${anchoredEnd ? "$" : ""}`;
}

/**
 * Build the shared WHERE clause for filter-based queries.
 */
function buildWhereClause({
  name,
  defaultCategoryId,
  search,
  active,
  uncategorized,
}: RecipientFilters): RawBuilder<unknown> {
  const conditions: RawBuilder<unknown>[] = [sql`1=1`];

  if (active) conditions.push(sql`r.is_active = true`);
  if (name) {
    conditions.push(sql`r.name REGEXP ${unicodeIlikeRegex(`%${name}%`)}`);
  }
  if (uncategorized) {
    // Phase 6: only surface recipients that both lack a default category
    // *and* have recorded activity. This previously read the trigger-maintained
    // `agg_recipient_totals` table (dropped in migration 0080 as pure write
    // overhead); it now probes `transactions` directly. Semantics are preserved
    // exactly: `agg_recipient_totals.transaction_count > 0` counted active,
    // non-transfer, currency-bearing rows keyed on the raw recipient_id (see
    // migrations 0035/0045), so the equivalent existence check is an active,
    // non-transfer transaction with a currency for this recipient. Served by
    // idx_transactions_recipient_date_active (recipient_id ... WHERE is_active).
    conditions.push(sql`r.default_category_id IS NULL
             AND EXISTS (
               SELECT 1 FROM transactions t
               WHERE t.recipient_id = r.id
                 AND t.is_active = true
                 AND t.is_transfer = false
                 AND t.currency IS NOT NULL
             )`);
  } else if (defaultCategoryId != null) {
    conditions.push(
      sql`r.default_category_id IN (SELECT category_id FROM category_ancestors WHERE ancestor_id = ${defaultCategoryId})`,
    );
  }
  if (search) {
    // The database folds case in the C locale (ASCII only). Search folds
    // Unicode case explicitly, without changing stored names or sorting.
    const sp = unicodeIlikeRegex(`%${search}%`);
    conditions.push(sql`(
      r.name REGEXP ${sp} OR
      r.notes REGEXP ${sp} OR
      c.general REGEXP ${sp} OR
      c.detail REGEXP ${sp} OR
      EXISTS (SELECT 1 FROM recipient_bank_accounts rba WHERE rba.recipient_id = r.id AND rba.account_number REGEXP ${sp})
    )`);
  }

  return sql`WHERE ${sql.join(conditions, sql` AND `)}`;
}

/** `IN (...)` over one JSON array parameter, however many ids there are. */
function inRecipientIds(ids: readonly RecipientId[]): RawBuilder<RecipientId> {
  return sql<RecipientId>`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}

/**
 * Insert a recipient, or touch the conflicting row so RETURNING always yields
 * the winning row's id (an upsert's DO UPDATE returns the existing row).
 */
function upsertRecipient(name: string, normalizedName: string, isActive: boolean) {
  return db
    .insertInto("recipients")
    .values({ name, normalized_name: normalizedName, is_active: isActive })
    .onConflict((oc) =>
      oc.column("normalized_name").doUpdateSet((eb) => ({
        normalized_name: eb.ref("excluded.normalized_name"),
      })),
    );
}

export const recipientRepository = {
  async getAll({
    limit = 50,
    offset = 0,
    name = null,
    defaultCategoryId = null,
    search = null,
    active = true,
    uncategorized = false,
    sortBy = null,
    sortDir = null,
  }: RecipientFilters = {}): Promise<EnrichedRecipientRow[]> {
    const where = buildWhereClause({
      name,
      defaultCategoryId,
      search,
      active,
      uncategorized,
    });

    // String(): the old untyped lookup coerced a null sortBy the same way.
    const sortCol = sortBy ? RECIPIENT_SORT_COLUMNS[sortBy] : undefined;
    // PostgreSQL sorts NULL as the largest value; SQLite as the smallest.
    const sortDirection =
      sortDir === "desc" ? sql`DESC NULLS FIRST` : sql`ASC NULLS LAST`;
    const orderBy = sortCol
      ? sql`${sortCol} ${sortDirection}, r.name ASC`
      : sql`r.name ASC`;

    return checkedRows(
      enrichedRecipientRowSchema,
      sql`${ENRICHED_RECIPIENTS}
      ${where}
      ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
    );
  },

  async getCount({
    name = null,
    defaultCategoryId = null,
    search = null,
    active = true,
    uncategorized = false,
  }: RecipientFilters = {}): Promise<number> {
    const where = buildWhereClause({
      name,
      defaultCategoryId,
      search,
      active,
      uncategorized,
    });

    const row = await checkedRow(
      countRowSchema,
      sql`SELECT count(*) AS "count::bigint" FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      ${where}`,
    );
    return parseInt(requireRow(row, "recipient count").count, 10);
  },

  async getById(id: RecipientId): Promise<EnrichedRecipientRow | null> {
    const row = await checkedRow(
      enrichedRecipientRowSchema,
      sql`${ENRICHED_RECIPIENTS}
      WHERE r.id = ${id}`,
    );
    return row ?? null;
  },

  /**
   * Id of the shared system recipient ({@link SYSTEM_RECIPIENT_NAME}), created
   * on first use. Server-generated ledger rows (reconcile 'adjustment', the
   * opening-balance anchor) have no payee but `transactions.recipient_id` is
   * NOT NULL, so they carry this id.
   *
   * Created at time of use rather than seeded by a migration: nothing else
   * needs it to exist, and an installation that never reconciles never grows
   * the row. It is created INACTIVE — `is_active = false` keeps it out of the
   * recipients page's default (active-only) list and out of the pickers that
   * request active recipients, while the FK and every transaction display join
   * (a plain LEFT JOIN on recipients) are indifferent to the flag.
   *
   * Two phases, because the row exists on all but the first call ever:
   *   1. SELECT by normalized_name. A hit returns without writing — no tuple
   *      churn, no row lock held for the rest of the caller's transaction, and
   *      no `updated_at` bump (which on an ADOPTED user recipient would edit
   *      the user's own row and invalidate the DB editor's xmin optimistic
   *      concurrency check on every reconcile).
   *   2. On a miss, INSERT ... ON CONFLICT DO UPDATE ... RETURNING id, so the
   *      id comes back unconditionally: a concurrent creator that inserted the
   *      row first holds the single write lock until it commits (ADR-263), and
   *      the DO UPDATE then returns its row.
   *
   * An existing user recipient that normalizes to the same name is adopted
   * as-is — never deactivated, and after phase 1 never even written to.
   */
  async getOrCreateSystemId(): Promise<RecipientId> {
    const normalized = normalizeForMatching(SYSTEM_RECIPIENT_NAME);
    const existing = await checkedRow(
      recipientKeyRowSchema,
      db
        .selectFrom("recipients")
        .select("id")
        .where("normalized_name", "=", normalized),
    );
    if (existing) return existing.id;

    const inserted = await checkedRow(
      recipientKeyRowSchema,
      upsertRecipient(SYSTEM_RECIPIENT_NAME, normalized, false).returning("id"),
    );
    return requireRow(inserted, "system recipient upsert").id;
  },

  /** @param name Raw display name; normalized before the lookup. */
  async getByName(name: string): Promise<RecipientRow | null> {
    const normalized = normalizeForMatching(name);
    const row = await checkedRow(
      recipientRowSchema,
      db
        .selectFrom("recipients")
        .selectAll()
        .where("normalized_name", "=", normalized),
    );
    return row ?? null;
  },

  /**
   * Get or create a public recipient by name.
   *
   * SYSTEM is reserved for server-generated ledger rows and can only be
   * resolved through getOrCreateSystemId(). The initial SELECT avoids touching
   * an established recipient. The conflict-safe upsert handles the concurrent
   * miss race and always returns the winning row's id.
   */
  async createOrGet({
    name,
  }: {
    name: string;
  }): Promise<{ recipient: EnrichedRecipientRow | null; created: boolean }> {
    const upperName = name.toUpperCase().trim();
    const normalizedName = normalizeForMatching(name);

    if (normalizedName === normalizeForMatching(SYSTEM_RECIPIENT_NAME)) {
      throw makeValidationError(
        `${SYSTEM_RECIPIENT_NAME} is reserved for server-generated transactions`,
      );
    }

    const existing = await checkedRow(
      recipientKeyRowSchema,
      db
        .selectFrom("recipients")
        .select("id")
        .where("normalized_name", "=", normalizedName),
    );

    let recipientId = existing?.id;
    let created = false;
    if (recipientId == null) {
      // The insert and the conflict fallback share one write transaction, so
      // `created` is exact: a conflicting row was committed before it began.
      ({ recipientId, created } = await withTransaction(async () => {
        const inserted = await checkedRow(
          recipientKeyRowSchema,
          db
            .insertInto("recipients")
            .values({
              name: upperName,
              normalized_name: normalizedName,
              is_active: true,
            })
            .onConflict((oc) => oc.column("normalized_name").doNothing())
            .returning("id"),
        );
        if (inserted) return { recipientId: inserted.id, created: true };
        const winner = requireRow(
          await checkedRow(
            recipientKeyRowSchema,
            db
              .selectFrom("recipients")
              .select("id")
              .where("normalized_name", "=", normalizedName),
          ),
          "recipient upsert",
        );
        return { recipientId: winner.id, created: false };
      }));
    }

    const full = await this.getById(recipientId);
    return { recipient: full, created };
  },

  async update(
    id: RecipientId,
    {
      name,
      default_category_id,
      notes,
      is_active,
    }: {
      name?: string | null | undefined;
      default_category_id?: CategoryId | null | undefined;
      notes?: string | null | undefined;
      is_active?: boolean | null | undefined;
    },
  ): Promise<EnrichedRecipientRow | null> {
    // undefined fields are skipped. A name write always updates the derived
    // normalized_name alongside it; null name / is_active mean "leave
    // unchanged".
    const hasName = name !== undefined && name !== null;
    if (
      hasName &&
      normalizeForMatching(name) === normalizeForMatching(SYSTEM_RECIPIENT_NAME)
    ) {
      throw makeValidationError(
        `${SYSTEM_RECIPIENT_NAME} is reserved for server-generated transactions`,
      );
    }
    const changes = {
      ...(hasName && {
        name: name.toUpperCase().trim(),
        normalized_name: normalizeForMatching(name),
      }),
      ...(default_category_id !== undefined && { default_category_id }),
      ...(notes !== undefined && { notes }),
      ...(is_active != null && { is_active }),
    };

    if (Object.keys(changes).length === 0) return this.getById(id);

    // One transaction: the enrichment reads the row this write produced.
    return withTransaction(async () => {
      const updated = await checkedRow(
        recipientKeyRowSchema,
        db
          .updateTable("recipients")
          .set({ ...changes, updated_at: sql<Date>`now()` })
          .where("id", "=", id)
          .returning("id"),
      );
      return updated ? this.getById(updated.id) : null;
    });
  },

  async hardDelete(id: RecipientId): Promise<boolean> {
    const result = await db
      .deleteFrom("recipients")
      .where("id", "=", id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  },

  /**
   * Read all merge participants' alias state inside the merge transaction. A
   * target can become an alias in a competing merge; the caller's BEGIN
   * IMMEDIATE transaction (ADR-263) runs after or before that merge, never
   * interleaved with it, so this read stays true until the merge commits.
   */
  async lockByIdsForMerge(
    ids: RecipientId[],
  ): Promise<
    Array<{ id: RecipientId; primary_recipient_id: RecipientId | null }>
  > {
    return checkedRows(
      recipientMergeLockRowSchema,
      db
        .selectFrom("recipients")
        .select(["id", "primary_recipient_id"])
        .where("id", "in", inRecipientIds(ids))
        .orderBy("id"),
    );
  },

  /**
   * Flag alias rows as pointing at the primary, preserving the historical alias
   * relationship for the Recipients UI + /:id/aliases. The atomic merge service
   * composes this with repointGrandchildAliases() in one transaction.
   * @returns the alias ids actually flagged
   */
  async flagAliasesOf(
    primaryId: RecipientId,
    aliasIds: RecipientId[],
  ): Promise<RecipientId[]> {
    const rows = await checkedRows(
      recipientKeyRowSchema,
      db
        .updateTable("recipients")
        .set({ primary_recipient_id: primaryId, updated_at: sql<Date>`now()` })
        .where("id", "in", inRecipientIds(aliasIds))
        .where("id", "<>", primaryId)
        .returning("id"),
    );
    return rows.map((r) => r.id);
  },

  /**
   * Re-point GRANDCHILDREN — recipients whose primary_recipient_id was one of
   * the now-merged aliases — onto the new primary. Without this, merging C→B
   * then B→A leaves C pointing at B (a depth-2 chain) that the one-level read
   * layer cannot resolve, so C vanishes from A's group.
   *
   * @returns rows repointed
   */
  async repointGrandchildAliases(
    primaryId: RecipientId,
    aliasIds: RecipientId[],
  ): Promise<number> {
    const result = await db
      .updateTable("recipients")
      .set({ primary_recipient_id: primaryId, updated_at: sql<Date>`now()` })
      .where("primary_recipient_id", "in", inRecipientIds(aliasIds))
      .where("id", "<>", primaryId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  },

  /**
   * Unmerge: remove primary_recipient_id from a recipient.
   */
  async unmergeRecipient(id: RecipientId): Promise<boolean> {
    const row = await db
      .updateTable("recipients")
      .set({ primary_recipient_id: null, updated_at: sql<Date>`now()` })
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
  },

  /**
   * Get all aliases for a primary recipient.
   */
  async getAliases(primaryId: RecipientId): Promise<RecipientAliasRow[]> {
    return checkedRows(
      recipientAliasRowSchema,
      db
        .selectFrom("recipients as r")
        .leftJoin("categories as c", "r.default_category_id", "c.id")
        .selectAll("r")
        .select(
          sql<string | null>`CASE WHEN c.id IS NOT NULL THEN c.path_name ELSE NULL END`.as(
            "default_category_name",
          ),
        )
        .where("r.primary_recipient_id", "=", primaryId)
        .orderBy("r.name"),
    );
  },

  /**
   * Resolve recipient ids to their cluster root (primary_recipient_id ?? id).
   * Returns a Map<recipientId, clusterRootId> for the ids that exist.
   */
  async getClusterRootMap(
    recipientIds: Array<RecipientId | null | undefined> | null | undefined,
  ): Promise<Map<RecipientId, RecipientId>> {
    const ids = [
      ...new Set(
        (recipientIds ?? []).filter((id): id is RecipientId => id != null),
      ),
    ];
    if (ids.length === 0) return new Map();
    const rows = await checkedRows(
      recipientClusterRootRowSchema,
      db
        .selectFrom("recipients")
        .select([
          "id",
          sql<RecipientId>`COALESCE(primary_recipient_id, id)`.as("cluster_root"),
        ])
        .where("id", "in", inRecipientIds(ids)),
    );
    const map = new Map<RecipientId, RecipientId>();
    for (const row of rows) map.set(row.id, row.cluster_root);
    return map;
  },
};

export default recipientRepository;

export { SYSTEM_RECIPIENT_NAME as __SYSTEM_RECIPIENT_NAME };
