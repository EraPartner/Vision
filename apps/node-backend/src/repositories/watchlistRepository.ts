/**
 * Watchlist Repository - data access for watchlist (prospective investments) table.
 */

import { query } from '../database/connection.ts';
import { queryOne, queryRows } from '../database/rowContracts.ts';
import { countRowSchema } from '../database/rowSchemas.ts';
import {
  watchlistCountedRowSchema,
  watchlistRowSchema,
} from '../database/rows/portfolio.ts';
import { coerceNumericFields } from '../lib/money.ts';
import { buildSetClauses } from '../lib/sqlClauses.ts';
import type { FormattedWatchlistRow, WatchlistRow } from '../types/rows.ts';

// target_price is NUMERIC (node-postgres returns it as a string); coerce on
// emit so it matches the `number` API/TS type. current_price/price_change are
// added later by the route from the price provider, not read from this table.
const WATCHLIST_NUMERIC_FIELDS = ['target_price', 'added_price'];

export type { WatchlistRow, FormattedWatchlistRow };

/** @param row A raw {@link WatchlistRow}. */
const mapWatchlistRow = (row: WatchlistRow): FormattedWatchlistRow =>
  coerceNumericFields<Record<string, unknown>>(
    row,
    WATCHLIST_NUMERIC_FIELDS,
  ) as FormattedWatchlistRow;

export const watchlistRepository = {
  buildWhereClause({
    assetClass = null,
  }: { assetClass?: string | null } = {}): {
    where: string;
    params: unknown[];
    nextParam: number;
  } {
    let where = 'WHERE 1=1';
    const params: unknown[] = [];
    let idx = 1;

    if (assetClass) {
      where += ` AND asset_class = $${idx++}`;
      params.push(assetClass);
    }

    return { where, params, nextParam: idx };
  },

  async getAll({
    limit = 50,
    offset = 0,
    assetClass = null,
  }: {
    limit?: number;
    offset?: number;
    assetClass?: string | null;
  } = {}): Promise<FormattedWatchlistRow[]> {
    const { where, params, nextParam } = this.buildWhereClause({ assetClass });
    let sql = `SELECT * FROM watchlist ${where}`;
    const idx = nextParam;

    sql += ` ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(limit, offset);

    const rows = await queryRows(watchlistRowSchema, sql, params);
    return rows.map(mapWatchlistRow);
  },

  async getAllWithCount({
    limit = 50,
    offset = 0,
    assetClass = null,
  }: {
    limit?: number;
    offset?: number;
    assetClass?: string | null;
  } = {}): Promise<{ rows: FormattedWatchlistRow[]; total: number }> {
    const { where, params, nextParam } = this.buildWhereClause({ assetClass });
    const idx = nextParam;
    const sql = `
      SELECT w.*, COUNT(*) OVER () AS total_count
      FROM watchlist w
      ${where.replace(/\basset_class\b/g, 'w.asset_class')}
      ORDER BY w.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const queryParams = [...params, limit, offset];
    const countedRows = await queryRows(
      watchlistCountedRowSchema,
      sql,
      queryParams,
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
    const { where, params } = this.buildWhereClause({ assetClass });
    const sql = `SELECT count(*) FROM watchlist ${where}`;

    const row = await queryOne(countRowSchema, sql, params);
    return parseInt(row!.count, 10);
  },

  async getById(id: number): Promise<FormattedWatchlistRow | null> {
    const row = await queryOne(watchlistRowSchema, 'SELECT * FROM watchlist WHERE id = $1', [id]);
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
    symbol?: string | null;
    asset_class: string;
    target_price: number | string;
    currency?: string;
    notes?: string | null;
    price_provider_id?: string | null;
    added_price?: number | string | null;
  }): Promise<FormattedWatchlistRow> {
    const row = await queryOne(
      watchlistRowSchema,
      `INSERT INTO watchlist (name, symbol, asset_class, target_price, currency, notes, price_provider_id, added_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, symbol || null, asset_class, target_price, currency, notes || null, price_provider_id || null, added_price ?? null]
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
    const { clauses: setClauses, params, nextIdx: idx } = buildSetClauses(fields, { allowed });

    if (setClauses.length === 0) return this.getById(id);

    params.push(id);
    const sql = `UPDATE watchlist SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`;
    const row = await queryOne(watchlistRowSchema, sql, params);
    return row ? mapWatchlistRow(row) : null;
  },

  /** @returns true if a row was removed */
  async delete(id: number): Promise<boolean> {
    const result = await query('DELETE FROM watchlist WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  },
};

export default watchlistRepository;
