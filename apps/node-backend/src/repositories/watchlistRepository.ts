/**
 * Watchlist Repository - data access for watchlist (prospective investments) table.
 */

import { requireRow } from "../database/rowContracts.ts";
import { sql } from 'kysely';
import type { SelectQueryBuilder } from 'kysely';
import { checkedRow, checkedRows, db } from '../database/db.ts';
import type { AssetClass, DB } from '../database/schema.generated.ts';
import { countRowSchema } from '../database/rowSchemas.ts';
import {
  watchlistCountedRowSchema,
  watchlistRowSchema,
} from '../database/rows/portfolio.ts';
import { coerceNumericFields } from '../lib/money.ts';
import type { FormattedWatchlistRow, WatchlistRow } from '../types/rows.ts';
import type { CurrencyCode } from '@vision/types/brands';

// target_price is NUMERIC (node-postgres returns it as a string); coerce on
// emit so it matches the `number` API/TS type. current_price/price_change are
// added later by the route from the price provider, not read from this table.
const WATCHLIST_NUMERIC_FIELDS = ['target_price', 'added_price'] as const;

export type { FormattedWatchlistRow };

/** @param row A raw {@link WatchlistRow}. */
const mapWatchlistRow = (row: WatchlistRow): FormattedWatchlistRow =>
  coerceNumericFields(row, WATCHLIST_NUMERIC_FIELDS);

/** Filter a `watchlist as w` query by asset class. */
function whereAssetClass<O>(
  builder: SelectQueryBuilder<DB & { w: DB['watchlist'] }, 'w', O>,
  assetClass: string | null,
) {
  return assetClass
    ? builder.where(sql<string>`w.asset_class`, '=', assetClass)
    : builder;
}

export const watchlistRepository = {
  async getAll({
    limit = 50,
    offset = 0,
    assetClass = null,
  }: {
    limit?: number;
    offset?: number;
    assetClass?: string | null;
  } = {}): Promise<FormattedWatchlistRow[]> {
    const rows = await checkedRows(
      watchlistRowSchema,
      whereAssetClass(db.selectFrom('watchlist as w').selectAll('w'), assetClass)
        .orderBy('w.created_at', 'desc')
        .limit(limit)
        .offset(offset),
    );
    return rows.map(mapWatchlistRow);
  },

  async getAllWithCount({
    limit = 50,
    offset = 0,
    assetClass = null,
  }: {
    limit?: number | undefined;
    offset?: number | undefined;
    assetClass?: string | null | undefined;
  } = {}): Promise<{ rows: FormattedWatchlistRow[]; total: number }> {
    const countedRows = await checkedRows(
      watchlistCountedRowSchema,
      whereAssetClass(
        db
          .selectFrom('watchlist as w')
          .selectAll('w')
          .select(sql<string>`COUNT(*) OVER ()`.as('total_count')),
        assetClass,
      )
        .orderBy('w.created_at', 'desc')
        .limit(limit)
        .offset(offset),
    );
    const [first] = countedRows;
    const total = first ? parseInt(first.total_count, 10) : 0;
    const rows = countedRows.map(({ total_count: _total_count, ...row }) =>
      mapWatchlistRow(row),
    );
    return { rows, total };
  },

  async getCount({
    assetClass = null,
  }: { assetClass?: string | null } = {}): Promise<number> {
    const row = await checkedRow(
      countRowSchema,
      whereAssetClass(
        db.selectFrom('watchlist as w').select(sql<string>`count(*)`.as('count')),
        assetClass,
      ),
    );
    return parseInt(requireRow(row, "watchlist count").count, 10);
  },

  async getById(id: number): Promise<FormattedWatchlistRow | null> {
    const row = await checkedRow(
      watchlistRowSchema,
      db.selectFrom('watchlist').selectAll().where('id', '=', id),
    );
    return row ? mapWatchlistRow(row) : null;
  },

  async create({
    name,
    symbol,
    asset_class,
    target_price,
    currency = 'EUR',
    notes,
    price_provider_id,
    added_price,
  }: {
    name: string;
    symbol?: string | null | undefined;
    asset_class: string;
    target_price: number | string;
    currency?: string | undefined;
    notes?: string | null | undefined;
    price_provider_id?: string | null | undefined;
    added_price?: number | string | null | undefined;
  }): Promise<FormattedWatchlistRow> {
    const row = await checkedRow(
      watchlistRowSchema,
      db
        .insertInto('watchlist')
        .values({
          name,
          symbol: symbol || null,
          // The enum column rejects an unknown asset class.
          asset_class: sql<AssetClass>`${asset_class}`,
          target_price,
          currency: sql<CurrencyCode>`${currency}`,
          notes: notes || null,
          price_provider_id: price_provider_id || null,
          added_price: added_price ?? null,
        })
        .returningAll(),
    );
    // An INSERT ... RETURNING without ON CONFLICT returns its row or throws.
    if (!row) throw new Error('Watchlist insert returned no row');
    return mapWatchlistRow(row);
  },

  /** @param fields Patch; only `allowed` keys are applied. */
  async update(
    id: number,
    fields: Record<string, unknown>,
  ): Promise<FormattedWatchlistRow | null> {
    const allowed = ['name', 'symbol', 'asset_class', 'target_price', 'currency', 'notes', 'price_provider_id'];
    // undefined fields are skipped; `allowed` whitelists the column names.
    const setClauses = Object.entries(fields)
      .filter(([key, value]) => value !== undefined && allowed.includes(key))
      .map(([key, value]) => sql`${sql.ref(key)} = ${value}`);

    if (setClauses.length === 0) return this.getById(id);

    const row = await checkedRow(
      watchlistRowSchema,
      sql`UPDATE watchlist SET ${sql.join(setClauses)} WHERE id = ${id} RETURNING *`,
    );
    return row ? mapWatchlistRow(row) : null;
  },

  /** @returns true if a row was removed */
  async delete(id: number): Promise<boolean> {
    const result = await db.deleteFrom('watchlist').where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  },
};

export default watchlistRepository;
