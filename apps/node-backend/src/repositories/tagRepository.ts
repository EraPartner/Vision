/**
 * Tag Repository — data access for the tags table.
 *
 * Tags are globally unique by slug to support soft-delete reactivation
 * while preserving junction row history.
 */

import { sql } from 'kysely';
import { withTransaction } from '../database/connection.ts';
import { checkedRow, checkedRows, db } from '../database/db.ts';
import { countRowSchema } from '../database/rowSchemas.ts';
import { requireRow, tagRowSchema } from '../database/rows/catalog.ts';

import type { TagRow } from '../types/rows.ts';
import type { TagId } from '@vision/types/brands';

export type { TagRow };

const tagRepository = {
  /**
   * List tags, optionally filtered by active status.
   *
   * `limit` is optional and defaults to unbounded — the tag pickers/filters
   * render every tag and have no paging, so only an explicit limit/offset
   * narrows the list.
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
    let builder = db.selectFrom('tags').selectAll().orderBy('slug');
    if (active !== null) builder = builder.where('is_active', '=', active);
    if (limit !== null) builder = builder.limit(limit).offset(offset);
    return checkedRows(tagRowSchema, builder);
  },

  /**
   * Count tags matching the active filter (for paginated list totals).
   * @returns `COUNT(*)` read as a bigint string; parsed here.
   */
  async getCount({
    active = null,
  }: { active?: boolean | null } = {}): Promise<number> {
    let builder = db
      .selectFrom('tags')
      .select(sql<string>`CAST(COUNT(*) AS TEXT)`.as('count'));
    if (active !== null) builder = builder.where('is_active', '=', active);
    const row = await checkedRow(countRowSchema, builder);
    return parseInt(requireRow(row, 'tag count').count, 10);
  },

  async getById(id: TagId): Promise<TagRow | null> {
    const row = await checkedRow(
      tagRowSchema,
      db.selectFrom('tags').selectAll().where('id', '=', id),
    );
    return row ?? null;
  },

  async getBySlug(slug: string): Promise<TagRow | null> {
    const row = await checkedRow(
      tagRowSchema,
      db.selectFrom('tags').selectAll().where('slug', '=', slug),
    );
    return row ?? null;
  },

  /**
   * Look up tags by slug array. Returns only rows that exist.
   */
  async getManyBySlugs(slugs: string[]): Promise<TagRow[]> {
    if (slugs.length === 0) return [];
    return checkedRows(
      tagRowSchema,
      db.selectFrom('tags').selectAll().where('slug', 'in', slugs),
    );
  },

  /**
   * Atomic find-or-create with reactivation.
   * If slug exists and is soft-deleted, it is reactivated.
   * Color is preserved if already set; new color is applied only if column was NULL.
   *
   * `reactivated` is true when the slug already existed (the upsert took its
   * DO UPDATE branch). SQLite has no `xmax`, so the existence read runs first,
   * in the same transaction as the upsert, on the single writer.
   *
   * @param slug  Already normalized by caller
   */
  async findOrCreateBySlug(
    slug: string,
    color: string | null = null,
  ): Promise<{ tag: TagRow; reactivated: boolean }> {
    return withTransaction(async (client) => {
      const existing = await checkedRow(
        tagRowSchema,
        db.selectFrom('tags').selectAll().where('slug', '=', slug),
        client,
      );
      const result = await checkedRow(
        tagRowSchema,
        db
          .insertInto('tags')
          .values({ slug, color })
          .onConflict((oc) =>
            oc.column('slug').doUpdateSet({
              is_active: true,
              color: sql<string | null>`COALESCE(tags.color, EXCLUDED.color)`,
              updated_at: sql<Date>`now()`,
            }),
          )
          .returningAll(),
        client,
      );
      const tag = requireRow(result, 'tag upsert');
      const wasConflict = existing !== undefined;
      return { tag, reactivated: wasConflict && tag.is_active };
    });
  },

  /**
   * Update allowed mutable fields: color and/or is_active.
   * Slug is immutable.
   */
  async update(
    id: TagId,
    {
      color,
      is_active,
    }: {
      color?: string | null | undefined;
      is_active?: boolean | null | undefined;
    },
  ): Promise<TagRow | null> {
    // undefined fields are skipped; null is_active means "leave unchanged".
    const changes = {
      ...(color !== undefined && { color }),
      ...(is_active != null && { is_active }),
    };
    if (Object.keys(changes).length === 0) return this.getById(id);

    const row = await checkedRow(
      tagRowSchema,
      db
        .updateTable('tags')
        .set({ ...changes, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .returningAll(),
    );
    return row ?? null;
  },

  /**
   * Soft delete: set is_active = false.
   */
  async softDelete(id: TagId): Promise<TagRow | null> {
    const row = await checkedRow(
      tagRowSchema,
      db
        .updateTable('tags')
        .set({ is_active: false, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .returningAll(),
    );
    return row ?? null;
  },

  /**
   * Count how many transactions reference a given tag (for reactivation toast).
   */
  async countTransactionReferences(tagId: TagId): Promise<number> {
    const row = await checkedRow(
      countRowSchema,
      db
        .selectFrom('transaction_tags')
        .select(sql<string>`CAST(COUNT(*) AS TEXT)`.as('count'))
        .where('tag_id', '=', tagId),
    );
    return parseInt(requireRow(row, 'tag reference count').count, 10);
  },
};

export default tagRepository;
