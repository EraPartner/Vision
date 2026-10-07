/**
 * Recipient Repository - data access for recipients table.
 *
 *
 * Performance notes:
 * - textNormalization is imported at module level to avoid per-call dynamic import overhead.
 * - createOrGet reads established rows without writing, then uses a conflict-safe
 *   upsert on a miss so concurrent creators both resolve the winning row.
 * - getAll + getCount share the same WHERE predicate but are kept separate for clarity.
 *   Callers that need both can call them concurrently via Promise.all.
 */

import { query } from "../database/connection.ts";
import { normalizeForMatching } from "../lib/textNormalization.ts";
import { buildSetClauses } from "../lib/sqlClauses.ts";
import { makeValidationError } from "../lib/repositoryErrors.ts";
import type { EnrichedRecipientRow, RecipientRow } from "../types/rows.ts";

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
  limit?: number;
  offset?: number;
  name?: string | null;
  defaultCategoryId?: number | null;
  search?: string | null;
  active?: boolean;
  uncategorized?: boolean;
  sortBy?: string | null;
  sortDir?: "asc" | "desc" | null;
}

// Allowed sort columns for recipients (maps frontend key -> SQL expression)
const RECIPIENT_SORT_COLUMNS: Record<string, string> = {
  name: "r.name",
  default_category_name: `CASE WHEN c.id IS NOT NULL THEN c.path_name ELSE NULL END`,
  primary_bank_account: "primary_bank_account",
  alias_count: "alias_count",
  notes: "r.notes",
  is_active: "r.is_active",
};

/**
 * Build the shared WHERE clause and params array for filter-based queries.
 */
function buildWhereClause({
  name,
  defaultCategoryId,
  search,
  active,
  uncategorized,
}: RecipientFilters): { sql: string; params: unknown[]; nextParam: number } {
  let sql = `WHERE 1=1`;
  const params: unknown[] = [];
  let p = 1;

  if (active) sql += ` AND r.is_active = true`;
  if (name) {
    sql += ` AND r.name ILIKE $${p++}`;
    params.push(`%${name}%`);
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
    sql += ` AND r.default_category_id IS NULL
             AND EXISTS (
               SELECT 1 FROM transactions t
               WHERE t.recipient_id = r.id
                 AND t.is_active = true
                 AND t.is_transfer = false
                 AND t.currency IS NOT NULL
             )`;
  } else if (defaultCategoryId != null) {
    sql += ` AND r.default_category_id IN (SELECT category_id FROM category_ancestors WHERE ancestor_id = $${p++})`;
    params.push(defaultCategoryId);
  }
  if (search) {
    const sp = `%${search}%`;
    // Use GIN trigram index on r.name for fast ILIKE; other columns fall back to seq scan
    sql += ` AND (
      r.name ILIKE $${p} OR
      r.notes ILIKE $${p} OR
      c.general ILIKE $${p} OR
      c.detail ILIKE $${p} OR
      EXISTS (SELECT 1 FROM recipient_bank_accounts rba WHERE rba.recipient_id = r.id AND rba.account_number ILIKE $${p})
    )`;
    p++;
    params.push(sp);
  }

  return { sql, params, nextParam: p };
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
    const {
      sql: where,
      params,
      nextParam: p,
    } = buildWhereClause({
      name,
      defaultCategoryId,
      search,
      active,
      uncategorized,
    });

    // String(): the old untyped lookup coerced a null sortBy the same way.
    const sortCol = RECIPIENT_SORT_COLUMNS[String(sortBy)] || "r.name";
    const sortDirection = sortDir === "desc" ? "DESC" : "ASC";
    const orderBy =
      sortBy && RECIPIENT_SORT_COLUMNS[sortBy]
        ? `${sortCol} ${sortDirection}, r.name ASC`
        : `r.name ASC`;

    const sql = `
      SELECT r.*,
             CASE WHEN c.id IS NOT NULL THEN c.path_name ELSE NULL END AS default_category_name,
             pba.account_number AS primary_bank_account,
             pr.name AS primary_recipient_name,
             COALESCE(ac.alias_count, 0) AS alias_count
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN LATERAL (
        SELECT rba.account_number
        FROM recipient_bank_accounts rba
        WHERE rba.recipient_id = r.id AND rba.is_active = true
        ORDER BY rba.is_primary DESC
        LIMIT 1
      ) pba ON true
      LEFT JOIN (
        SELECT primary_recipient_id, count(*)::int AS alias_count
        FROM recipients
        WHERE primary_recipient_id IS NOT NULL
        GROUP BY primary_recipient_id
      ) ac ON ac.primary_recipient_id = r.id
      ${where}
      ORDER BY ${orderBy} LIMIT $${p} OFFSET $${p + 1}
    `;

    const result = await query<EnrichedRecipientRow>(sql, [
      ...params,
      limit,
      offset,
    ]);
    return result.rows;
  },

  async getCount({
    name = null,
    defaultCategoryId = null,
    search = null,
    active = true,
    uncategorized = false,
  }: RecipientFilters = {}): Promise<number> {
    const { sql: where, params } = buildWhereClause({
      name,
      defaultCategoryId,
      search,
      active,
      uncategorized,
    });

    const sql = `
      SELECT count(*) FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      ${where}
    `;
    const result = await query<{ count: string }>(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id: number): Promise<EnrichedRecipientRow | null> {
    const sql = `
      SELECT r.*,
             CASE WHEN c.id IS NOT NULL THEN c.path_name ELSE NULL END AS default_category_name,
             pba.account_number AS primary_bank_account,
             pr.name AS primary_recipient_name,
             COALESCE(ac.alias_count, 0) AS alias_count
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN LATERAL (
        SELECT rba.account_number
        FROM recipient_bank_accounts rba
        WHERE rba.recipient_id = r.id AND rba.is_active = true
        ORDER BY rba.is_primary DESC
        LIMIT 1
      ) pba ON true
      LEFT JOIN (
        SELECT primary_recipient_id, count(*)::int AS alias_count
        FROM recipients
        WHERE primary_recipient_id IS NOT NULL
        GROUP BY primary_recipient_id
      ) ac ON ac.primary_recipient_id = r.id
      WHERE r.id = $1
    `;
    const result = await query<EnrichedRecipientRow>(sql, [id]);
    return result.rows[0] || null;
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
   *   2. On a miss, INSERT ... ON CONFLICT DO UPDATE ... RETURNING id — not
   *      `createOrGet`'s DO NOTHING + re-SELECT, which finds nothing when a
   *      concurrent transaction has inserted the row but not yet committed.
   *      Here that would surface as a failed reconcile rather than a skipped
   *      import row, so the id must come back unconditionally: DO UPDATE blocks
   *      on the conflicting row and always returns it.
   *
   * An existing user recipient that normalizes to the same name is adopted
   * as-is — never deactivated, and after phase 1 never even written to.
   */
  async getOrCreateSystemId(): Promise<number> {
    const normalized = normalizeForMatching(SYSTEM_RECIPIENT_NAME);
    const existing = await query<{ id: number }>(
      `SELECT id FROM recipients WHERE normalized_name = $1`,
      [normalized],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const result = await query<{ id: number }>(
      `INSERT INTO recipients (name, normalized_name, is_active)
       VALUES ($1, $2, false)
       ON CONFLICT (normalized_name) DO UPDATE SET normalized_name = EXCLUDED.normalized_name
       RETURNING id`,
      [SYSTEM_RECIPIENT_NAME, normalized],
    );
    return result.rows[0].id;
  },

  /** @param name Raw display name; normalized before the lookup. */
  async getByName(name: string): Promise<RecipientRow | null> {
    const normalized = normalizeForMatching(name);
    const result = await query<RecipientRow>(
      `SELECT * FROM recipients WHERE normalized_name = $1`,
      [normalized],
    );
    return result.rows[0] || null;
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

    const existingResult = await query<{ id: number }>(
      `SELECT id FROM recipients WHERE normalized_name = $1`,
      [normalizedName],
    );

    let recipientId = existingResult.rows[0]?.id;
    let created = false;
    if (recipientId == null) {
      const insertResult = await query<{ id: number; created: boolean }>(
        `INSERT INTO recipients (name, normalized_name, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (normalized_name) DO UPDATE
         SET normalized_name = EXCLUDED.normalized_name
       RETURNING id, (xmax = 0) AS created`,
        [upperName, normalizedName],
      );
      recipientId = insertResult.rows[0].id;
      created = Boolean(insertResult.rows[0].created);
    }

    const full = await this.getById(recipientId);
    return { recipient: full, created };
  },

  async update(
    id: number,
    {
      name,
      default_category_id,
      notes,
      is_active,
    }: {
      name?: string | null;
      default_category_id?: number | null;
      notes?: string | null;
      is_active?: boolean | null;
    },
  ): Promise<EnrichedRecipientRow | null> {
    // Shared clause builder (lib/sqlClauses.ts): undefined fields are skipped.
    // A name write always updates the derived normalized_name alongside it;
    // null name / is_active mean "leave unchanged" (pre-mapped to undefined).
    const hasName = name !== undefined && name !== null;
    if (
      hasName &&
      normalizeForMatching(name) === normalizeForMatching(SYSTEM_RECIPIENT_NAME)
    ) {
      throw makeValidationError(
        `${SYSTEM_RECIPIENT_NAME} is reserved for server-generated transactions`,
      );
    }
    const {
      clauses: setClauses,
      params,
      nextIdx: paramIdx,
    } = buildSetClauses({
      name: hasName ? name.toUpperCase().trim() : undefined,
      normalized_name: hasName ? normalizeForMatching(name) : undefined,
      default_category_id,
      notes,
      is_active: is_active ?? undefined,
    });

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `
      WITH updated AS (
        UPDATE recipients
        SET ${setClauses.join(", ")}
        WHERE id = $${paramIdx}
        RETURNING *
      )
      SELECT u.*,
             CASE WHEN c.id IS NOT NULL THEN c.path_name ELSE NULL END AS default_category_name,
             pba.account_number AS primary_bank_account,
             pr.name AS primary_recipient_name,
             COALESCE(ac.alias_count, 0) AS alias_count
      FROM updated u
      LEFT JOIN categories c ON u.default_category_id = c.id
      LEFT JOIN recipients pr ON u.primary_recipient_id = pr.id
      LEFT JOIN LATERAL (
        SELECT rba.account_number
        FROM recipient_bank_accounts rba
        WHERE rba.recipient_id = u.id AND rba.is_active = true
        ORDER BY rba.is_primary DESC
        LIMIT 1
      ) pba ON true
      LEFT JOIN (
        SELECT primary_recipient_id, count(*)::int AS alias_count
        FROM recipients
        WHERE primary_recipient_id IS NOT NULL
        GROUP BY primary_recipient_id
      ) ac ON ac.primary_recipient_id = u.id
    `;
    const result = await query<EnrichedRecipientRow>(sql, params);
    return result.rows[0] || null;
  },

  async hardDelete(id: number): Promise<boolean> {
    const result = await query("DELETE FROM recipients WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Lock all merge participants in a consistent order before reading alias
   * state. A target can become an alias while a competing merge holds its lock.
   */
  async lockByIdsForMerge(
    ids: number[],
  ): Promise<Array<{ id: number; primary_recipient_id: number | null }>> {
    const result = await query<{
      id: number;
      primary_recipient_id: number | null;
    }>(
      `SELECT id, primary_recipient_id FROM recipients
       WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
    return result.rows;
  },

  /**
   * Flag alias rows as pointing at the primary, preserving the historical alias
   * relationship for the Recipients UI + /:id/aliases. The atomic merge service
   * composes this with repointGrandchildAliases() in one transaction.
   * @returns the alias ids actually flagged
   */
  async flagAliasesOf(
    primaryId: number,
    aliasIds: number[],
  ): Promise<number[]> {
    const result = await query<{ id: number }>(
      `UPDATE recipients
          SET primary_recipient_id = $1,
              updated_at = NOW()
        WHERE id = ANY($2::int[])
          AND id <> $1
        RETURNING id`,
      [primaryId, aliasIds],
    );
    return result.rows.map((r) => r.id);
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
    primaryId: number,
    aliasIds: number[],
  ): Promise<number> {
    const result = await query(
      `UPDATE recipients
          SET primary_recipient_id = $1,
              updated_at = NOW()
        WHERE primary_recipient_id = ANY($2::int[])
          AND id <> $1`,
      [primaryId, aliasIds],
    );
    return result.rowCount ?? 0;
  },

  /**
   * Unmerge: remove primary_recipient_id from a recipient.
   */
  async unmergeRecipient(id: number): Promise<boolean> {
    const sql = `UPDATE recipients SET primary_recipient_id = NULL, updated_at = NOW() WHERE id = $1 RETURNING id`;
    const result = await query(sql, [id]);
    return result.rows.length > 0;
  },

  /**
   * Get all aliases for a primary recipient.
   */
  async getAliases(
    primaryId: number,
  ): Promise<(RecipientRow & { default_category_name: string | null })[]> {
    const sql = `
      SELECT r.*,
             CASE WHEN c.id IS NOT NULL THEN c.path_name ELSE NULL END AS default_category_name
      FROM recipients r
      LEFT JOIN categories c ON r.default_category_id = c.id
      WHERE r.primary_recipient_id = $1
      ORDER BY r.name
    `;
    const result = await query<
      RecipientRow & { default_category_name: string | null }
    >(sql, [primaryId]);
    return result.rows;
  },

  /**
   * Resolve recipient ids to their cluster root (primary_recipient_id ?? id).
   * Returns a Map<recipientId, clusterRootId> for the ids that exist.
   */
  async getClusterRootMap(
    recipientIds: Array<number | null | undefined> | null | undefined,
  ): Promise<Map<number, number>> {
    const ids = [
      ...new Set((recipientIds || []).filter((id): id is number => id != null)),
    ];
    if (ids.length === 0) return new Map();
    const result = await query<{ id: number; cluster_root: number }>(
      `SELECT id, COALESCE(primary_recipient_id, id) AS cluster_root
         FROM recipients
        WHERE id = ANY($1::int[])`,
      [ids],
    );
    const map = new Map<number, number>();
    for (const row of result.rows) map.set(row.id, row.cluster_root);
    return map;
  },
};

export default recipientRepository;

export { SYSTEM_RECIPIENT_NAME as __SYSTEM_RECIPIENT_NAME };
