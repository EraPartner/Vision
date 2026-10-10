/**
 * Tag Repository — data access for the tags table.
 *
 * Tags are globally unique by slug to support soft-delete reactivation
 * while preserving junction row history.
 */

import { queryOne, queryRows } from '../database/rowContracts.ts';
import { countRowSchema } from '../database/rowSchemas.ts';
import {
  requireRow,
  tagRowSchema,
  tagUpsertRowSchema,
} from '../database/rows/catalog.ts';
import { buildLimitOffset, buildSetClauses } from '../lib/sqlClauses.ts';

import type { TagRow } from '../types/rows.ts';

export type { TagRow };

export const tagRepository = {
  /**
   * List tags, optionally filtered by active status.
   *
   * `limit` is optional and defaults to unbounded — the tag pickers/filters
   * render every tag and have no paging, so only an explicit limit/offset
   * narrows the list (buildLimitOffset).
   */
  async getAll({
    active = null,
    limit = null,
    offset = 0,
  }: {
    active?: boolean | null;
    limit?: number | null;
    offset?: number;
  } = {}): Promise<TagRow[]> {
    let sql = 'SELECT * FROM tags WHERE 1=1';

    if (active === true) {
      sql += ` AND is_active = true`;
    } else if (active === false) {
      sql += ` AND is_active = false`;
    }

    sql += ` ORDER BY slug`;
    const params: unknown[] = [];
    sql += buildLimitOffset(params, { limit, offset });
    return queryRows(tagRowSchema, sql, params);
  },

  /**
   * Count tags matching the active filter (for paginated list totals).
   * @returns `COUNT(*)` is a bigint string; parsed here.
   */
  async getCount({
    active = null,
  }: { active?: boolean | null } = {}): Promise<number> {
    let sql = 'SELECT COUNT(*) FROM tags WHERE 1=1';
    const params: unknown[] = [];

    if (active === true) {
      sql += ` AND is_active = true`;
    } else if (active === false) {
      sql += ` AND is_active = false`;
    }

    const row = await queryOne(countRowSchema, sql, params);
    return parseInt(requireRow(row, 'tag count').count, 10);
  },

  async getById(id: number): Promise<TagRow | null> {
    const row = await queryOne(tagRowSchema, 'SELECT * FROM tags WHERE id = $1', [id]);
    return row ?? null;
  },

  async getBySlug(slug: string): Promise<TagRow | null> {
    const row = await queryOne(tagRowSchema, 'SELECT * FROM tags WHERE slug = $1', [slug]);
    return row ?? null;
  },

  /**
   * Look up tags by slug array. Returns only rows that exist.
   */
  async getManyBySlugs(slugs: string[]): Promise<TagRow[]> {
    if (slugs.length === 0) return [];
    return queryRows(
      tagRowSchema,
      'SELECT * FROM tags WHERE slug = ANY($1::text[])',
      [slugs]
    );
  },

  /**
   * Atomic find-or-create with reactivation.
   * If slug exists and is soft-deleted, it is reactivated.
   * Color is preserved if already set; new color is applied only if column was NULL.
   *
   * @param slug  Already normalized by caller
   */
  async findOrCreateBySlug(
    slug: string,
    color: string | null = null,
  ): Promise<{ tag: TagRow; reactivated: boolean }> {
    const result = await queryOne(
      tagUpsertRowSchema,
      `INSERT INTO tags (slug, color)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE
         SET is_active = true,
             color     = COALESCE(tags.color, EXCLUDED.color),
             updated_at = NOW()
       RETURNING *, (xmax <> 0) AS was_conflict`,
      [slug, color]
    );
    const row = requireRow(result, 'tag upsert');
    const reactivated = row.was_conflict && row.is_active;
    const { was_conflict: _wc, ...tag } = row;
    return { tag, reactivated };
  },

  /**
   * Update allowed mutable fields: color and/or is_active.
   * Slug is immutable.
   */
  async update(
    id: number,
    {
      color,
      is_active,
    }: { color?: string | null; is_active?: boolean | null },
  ): Promise<TagRow | null> {
    // Shared clause builder (lib/sqlClauses.ts): undefined fields are skipped;
    // null is_active means "leave unchanged" (pre-mapped to undefined).
    const { clauses: setClauses, params, nextIdx: idx } = buildSetClauses({
      color,
      is_active: is_active ?? undefined,
    });

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push('updated_at = NOW()');
    params.push(id);
    const row = await queryOne(
      tagRowSchema,
      `UPDATE tags SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return row ?? null;
  },

  /**
   * Soft delete: set is_active = false.
   */
  async softDelete(id: number): Promise<TagRow | null> {
    const row = await queryOne(
      tagRowSchema,
      `UPDATE tags SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    return row ?? null;
  },

  /**
   * Count how many transactions reference a given tag (for reactivation toast).
   */
  async countTransactionReferences(tagId: number): Promise<number> {
    const row = await queryOne(
      countRowSchema,
      'SELECT COUNT(*) FROM transaction_tags WHERE tag_id = $1',
      [tagId]
    );
    return parseInt(requireRow(row, 'tag reference count').count, 10);
  },
};

export default tagRepository;
