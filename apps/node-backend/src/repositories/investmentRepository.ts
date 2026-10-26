/**
 * Investment Repository - data access for investments table.
 *
 * `investments` is a plain flat table on every install: fresh installs get it from the
 * 0001 baseline and legacy table-inheritance installs are converted by migration 0087
 * (ADR-109) before the backend starts listening, so no schema-shape probing is needed.
 */

import { requireRow } from "../database/rowContracts.ts";
import { sql } from "kysely";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import { countRowSchema } from "../database/rowSchemas.ts";
import {
  investmentCountedDbRowSchema,
  investmentDbRowSchema,
  latestPriceUpdatedAtRowSchema,
  portfolioIntIdRowSchema,
} from "../database/rows/portfolio.ts";
import type { InvestmentDbRow } from "../database/rows/portfolio.ts";
import { VALID_ASSET_CLASSES } from "../lib/assetClasses.ts";
import { toWireDate } from "../lib/dateFormat.ts";
import { coerceNumericFields } from "../lib/money.ts";
import { makeValidationError } from "../lib/repositoryErrors.ts";
import type {
  Investments,
  PriceProvider,
} from "../database/schema.generated.ts";

import type { InvestmentRow } from "../types/rows.ts";
import { EUR } from "../lib/currencyCode.ts";
import type { CurrencyCode, InvestmentId } from "@vision/types/brands";

export type { InvestmentRow };

/**
 * The caller-facing create payload — one key per column in
 * INVESTMENT_CREATE_COLUMNS. Every field except `name` / `asset_class` is
 * optional and falls back to a per-column default.
 */
export interface InvestmentCreateFields {
  name: string;
  asset_class: string;
  symbol?: string | null | undefined;
  currency?: CurrencyCode | undefined;
  current_price?: number | string | null | undefined;
  interest_rate?: number | string | null | undefined;
  /** 'YYYY-MM-DD' */
  maturity_date?: string | null | undefined;
  location?: string | null | undefined;
  municipality?: string | null | undefined;
  cadastral_income?: number | string | null | undefined;
  municipality_tax_rate?: number | string | null | undefined;
  notes?: string | null | undefined;
  price_provider?: string | null | undefined;
  price_provider_id?: string | null | undefined;
  price_provider_url?: string | null | undefined;
  price_provider_latest_url?: string | null | undefined;
  price_provider_latest_path?: string | null | undefined;
  price_provider_history_url?: string | null | undefined;
  price_provider_history_path?: string | null | undefined;
  price_provider_history_ts_path?: string | null | undefined;
  price_provider_history_price_path?: string | null | undefined;
}

/** List filters shared by getAll / getAllWithCount (and getCount). */
interface InvestmentListFilters {
  limit?: number;
  offset?: number;
  assetClass?: string | null;
  active?: boolean;
}

// NUMERIC columns node-postgres returns as strings; coerce to numbers on emit
// so rows match the `number` API/TS types.
const INVESTMENT_NUMERIC_FIELDS = [
  "current_price",
  "interest_rate",
  "cadastral_income",
  "municipality_tax_rate",
] as const;
/**
 * Coerce an `investments` row to its emitted shape: the four NUMERIC columns
 * become numbers and the DATE `maturity_date` a calendar-day string.
 */
const mapInvestmentRow = (row: InvestmentDbRow): InvestmentRow => {
  const coerced = coerceNumericFields(row, INVESTMENT_NUMERIC_FIELDS);
  // DATE column: calendar-day string, not a raw pg Date (previous-day ISO
  // timestamp east of UTC once JSON-serialized).
  return {
    ...coerced,
    maturity_date:
      coerced.maturity_date instanceof Date
        ? toWireDate(coerced.maturity_date)
        : coerced.maturity_date,
  };
};

// Create stores an empty or zero price/rate as NULL ("not set").
function blankOrZeroToNull(value: number | string | null | undefined) {
  return value === "" || value === 0 ? null : (value ?? null);
}

/** Column names for a create() payload — the caller-facing field set. */
const INVESTMENT_CREATE_COLUMNS = [
  "name",
  "symbol",
  "asset_class",
  "currency",
  "current_price",
  "interest_rate",
  "maturity_date",
  "location",
  "municipality",
  "cadastral_income",
  "municipality_tax_rate",
  "notes",
  "price_provider",
  "price_provider_id",
  "price_provider_url",
  "price_provider_latest_url",
  "price_provider_latest_path",
  "price_provider_history_url",
  "price_provider_history_path",
  "price_provider_history_ts_path",
  "price_provider_history_price_path",
] as const satisfies ReadonlyArray<keyof InvestmentCreateFields>;

// Widened to Set<string>: create() probes a raw payload value with .has()
// (same idiom as UNIT_BASED_ASSET_CLASSES in portfolioTransactionRules.js).
const SUPPORTED_ASSET_CLASSES = new Set<string>(VALID_ASSET_CLASSES);

function isSupportedAssetClass(
  value: string,
): value is Investments["asset_class"] {
  return SUPPORTED_ASSET_CLASSES.has(value);
}

/** The INSERT row for a create() payload, with each column's default. */
function investmentInsertValues(
  f: InvestmentCreateFields & { asset_class: Investments["asset_class"] },
) {
  return {
    name: f.name,
    symbol: f.symbol || null,
    asset_class: f.asset_class,
    currency: f.currency,
    current_price: blankOrZeroToNull(f.current_price),
    interest_rate: blankOrZeroToNull(f.interest_rate),
    maturity_date: f.maturity_date || null,
    location: f.location || null,
    municipality: f.municipality || null,
    cadastral_income: f.cadastral_income ?? null,
    municipality_tax_rate: f.municipality_tax_rate ?? null,
    notes: f.notes || null,
    // The price_provider enum column rejects an unknown provider.
    price_provider: sql<PriceProvider>`${f.price_provider || "manual"}`,
    price_provider_id: f.price_provider_id || null,
    price_provider_url: f.price_provider_url || null,
    price_provider_latest_url: f.price_provider_latest_url || null,
    price_provider_latest_path: f.price_provider_latest_path || null,
    price_provider_history_url: f.price_provider_history_url || null,
    price_provider_history_path: f.price_provider_history_path || null,
    price_provider_history_ts_path: f.price_provider_history_ts_path || null,
    price_provider_history_price_path:
      f.price_provider_history_price_path || null,
  };
}

/**
 * Pick the investment create field set out of a request body, preserving the
 * exact key set create() expects (each key present, undefined when absent so
 * create()'s per-field defaults still apply). Lets the controller stop
 * re-destructuring the same ~21 fields by hand.
 *
 * The body is unvalidated request input; create() itself rejects a missing
 * name or an unsupported asset_class.
 */
export function pickInvestmentCreateFields(
  body: Record<string, unknown>,
): InvestmentCreateFields {
  const picked: Record<string, unknown> = {};
  for (const column of INVESTMENT_CREATE_COLUMNS)
    picked[column] = body[column];
  return picked as unknown as InvestmentCreateFields;
}

/**
 * @returns the trimmed/upper-cased string, or `value` unchanged when not a string
 */
function normalizeSymbol<T>(value: T): T | string {
  if (typeof value !== "string") return value;
  return value.trim().toUpperCase();
}

async function ensureSymbolIsUnique(
  symbol: unknown,
  excludeId?: InvestmentId,
): Promise<void> {
  let builder = db
    .selectFrom("investments")
    .select("id")
    .where(sql<string>`LOWER(symbol)`, "=", sql<string>`LOWER(${symbol})`)
    .limit(1);
  if (excludeId !== undefined) builder = builder.where("id", "<>", excludeId);
  const duplicate = await checkedRow(portfolioIntIdRowSchema, builder);

  if (duplicate) {
    throw makeValidationError("symbol must be unique");
  }
}

// Per-investment ticker visibility lives in a side table (migration 0061).
// Reads LEFT JOIN it (absent row = visible); the toggle UPSERTs it via
// update() below.
function selectInvestmentsWithTickerPref() {
  return db
    .selectFrom("investments as i")
    .leftJoin("investment_ticker_prefs as tp", "tp.investment_id", "i.id")
    .selectAll("i")
    .select(sql<boolean>`COALESCE(tp.show_in_ticker, true)`.as("show_in_ticker"));
}

async function setTickerPreference(
  id: InvestmentId,
  show: boolean,
): Promise<void> {
  await db
    .insertInto("investment_ticker_prefs")
    .values({ investment_id: id, show_in_ticker: show })
    .onConflict((oc) =>
      oc
        .column("investment_id")
        .doUpdateSet((eb) => ({
          show_in_ticker: eb.ref("excluded.show_in_ticker"),
        })),
    )
    .execute();
}

export const investmentRepository = {
  async getAll({
    limit = 50,
    offset = 0,
    assetClass = null,
    active = true,
  }: InvestmentListFilters = {}): Promise<InvestmentRow[]> {
    let builder = selectInvestmentsWithTickerPref();
    if (active) builder = builder.where("i.is_active", "=", true);
    if (assetClass)
      builder = builder.where(sql<string>`i.asset_class`, "=", assetClass);

    const rows = await checkedRows(
      investmentDbRowSchema,
      builder.orderBy("i.name").limit(limit).offset(offset),
    );
    return rows.map(mapInvestmentRow);
  },

  async getCount({
    assetClass = null,
    active = true,
  }: Omit<InvestmentListFilters, "limit" | "offset"> = {}): Promise<number> {
    let builder = db
      .selectFrom("investments")
      .select(sql<string>`count(*)`.as("count"));
    if (active) builder = builder.where("is_active", "=", true);
    if (assetClass)
      builder = builder.where(sql<string>`asset_class`, "=", assetClass);

    const row = await checkedRow(countRowSchema, builder);
    return parseInt(requireRow(row, "investment count").count, 10);
  },

  async getAllWithCount({
    limit = 50,
    offset = 0,
    assetClass = null,
    active = true,
  }: InvestmentListFilters = {}): Promise<{
    rows: InvestmentRow[];
    total: number;
  }> {
    let builder = selectInvestmentsWithTickerPref().select(
      sql<string>`COUNT(*) OVER ()`.as("total_count"),
    );
    if (active) builder = builder.where("i.is_active", "=", true);
    if (assetClass)
      builder = builder.where(sql<string>`i.asset_class`, "=", assetClass);

    const countedRows = await checkedRows(
      investmentCountedDbRowSchema,
      builder.orderBy("i.name").limit(limit).offset(offset),
    );
    const [first] = countedRows;
    const total = first ? parseInt(first.total_count, 10) : 0;
    const rows = countedRows.map(({ total_count: _total_count, ...row }) =>
      mapInvestmentRow(row),
    );
    return { rows, total };
  },

  async getById(id: InvestmentId): Promise<InvestmentRow | null> {
    const row = await checkedRow(
      investmentDbRowSchema,
      selectInvestmentsWithTickerPref().where("i.id", "=", id),
    );
    return row ? mapInvestmentRow(row) : null;
  },

  async create({
    name,
    symbol,
    asset_class,
    currency = EUR,
    current_price,
    interest_rate,
    maturity_date,
    location,
    municipality,
    cadastral_income,
    municipality_tax_rate,
    notes,
    price_provider,
    price_provider_id,
    price_provider_url,
    price_provider_latest_url,
    price_provider_latest_path,
    price_provider_history_url,
    price_provider_history_path,
    price_provider_history_ts_path,
    price_provider_history_price_path,
  }: InvestmentCreateFields): Promise<InvestmentRow | null> {
    // Apply the same input hygiene as update(): reject an empty name (the
    // backend previously accepted '' silently) and normalise the symbol
    // (trim/uppercase) so a lower-case symbol can't slip in only via create.
    const trimmedName = typeof name === "string" ? name.trim() : name;
    if (!trimmedName) {
      throw makeValidationError("name is required");
    }
    name = trimmedName;
    // Same 400 the legacy inheritance path raised — without this, an unknown
    // asset_class only fails at the DB enum cast (a raw 500).
    if (!isSupportedAssetClass(asset_class)) {
      throw makeValidationError(`Unsupported asset_class: ${asset_class}`);
    }
    symbol = normalizeSymbol(symbol);
    // Same uniqueness rule as update() (there is no DB unique index on symbol,
    // so create was the one path that could still insert a duplicate — e.g. a
    // duplicate-on-retry).
    if (typeof symbol === "string" && symbol !== "") {
      await ensureSymbolIsUnique(symbol);
    }
    const payload = {
      name,
      symbol,
      asset_class,
      currency,
      current_price,
      interest_rate,
      maturity_date,
      location,
      municipality,
      cadastral_income,
      municipality_tax_rate,
      notes,
      price_provider,
      price_provider_id,
      price_provider_url,
      price_provider_latest_url,
      price_provider_latest_path,
      price_provider_history_url,
      price_provider_history_path,
      price_provider_history_ts_path,
      price_provider_history_price_path,
    };

    const row = await checkedRow(
      investmentDbRowSchema,
      db
        .insertInto("investments")
        .values(investmentInsertValues(payload))
        .returningAll(),
    );
    // An INSERT ... RETURNING without ON CONFLICT returns its row or throws.
    return row ? mapInvestmentRow(row) : null;
  },

  async update(
    id: InvestmentId,
    fields: Record<string, unknown> & { show_in_ticker?: boolean },
  ): Promise<InvestmentRow | null> {
    const allowed = [
      "name",
      "symbol",
      "currency",
      "current_price",
      "interest_rate",
      "maturity_date",
      "location",
      "municipality",
      "cadastral_income",
      "municipality_tax_rate",
      "notes",
      "is_active",
      "price_provider",
      "price_provider_id",
      "price_provider_url",
      "price_provider_latest_url",
      "price_provider_latest_path",
      "price_provider_history_url",
      "price_provider_history_path",
      "price_provider_history_ts_path",
      "price_provider_history_price_path",
      "price_updated_at",
    ];
    const existing = await this.getById(id);
    if (!existing) return null;

    if (
      Object.prototype.hasOwnProperty.call(fields, "asset_class") &&
      fields.asset_class !== existing.asset_class
    ) {
      throw makeValidationError("asset_class cannot be changed");
    }

    // show_in_ticker is not an investments column — it's a side-table preference
    // (migration 0061). Peel it off; UPSERT it after the field validations below
    // so an invalid symbol can't leave a stray preference behind.
    const { show_in_ticker: showInTicker, ...rest } = fields;

    const normalizedFields: Record<string, unknown> = { ...rest };
    if (Object.prototype.hasOwnProperty.call(normalizedFields, "symbol")) {
      const symbol = normalizeSymbol(normalizedFields.symbol);
      if (!symbol) {
        throw makeValidationError("symbol is required");
      }
      await ensureSymbolIsUnique(symbol, id);
      normalizedFields.symbol = symbol;
    }

    if (showInTicker !== undefined) {
      await setTickerPreference(id, showInTicker);
    }

    // undefined fields are skipped; `allowed` whitelists the column names.
    const setClauses = Object.entries(normalizedFields)
      .filter(([key, value]) => value !== undefined && allowed.includes(key))
      .map(([key, value]) => sql`${sql.ref(key)} = ${value}`);

    // Nothing else changed — re-read only if the ticker pref moved (to reflect it).
    if (setClauses.length === 0) {
      return showInTicker !== undefined ? this.getById(id) : existing;
    }

    const row = await checkedRow(
      investmentDbRowSchema,
      sql`UPDATE investments SET ${sql.join(setClauses)} WHERE id = ${id} RETURNING *`,
    );
    if (!row) return null;
    // Re-read when the ticker pref changed so the joined value is in the response.
    return showInTicker !== undefined
      ? this.getById(id)
      : mapInvestmentRow(row);
  },

  async updatePrice(
    id: InvestmentId,
    {
      current_price,
      price_updated_at,
    }: {
      current_price: number | string | null;
      price_updated_at: string | Date | null;
    },
  ): Promise<InvestmentRow | null> {
    const row = await checkedRow(
      investmentDbRowSchema,
      db
        .updateTable("investments")
        .set({ current_price, price_updated_at })
        .where("id", "=", id)
        .returningAll(),
    );
    return row ? mapInvestmentRow(row) : null;
  },

  /**
   * Batch variant of updatePrice: one UNNEST-driven UPDATE for the whole
   * refresh instead of N sequential round trips (same pattern as
   * priceCache.saveHistoricalPointsToDatabase).
   *
   * @returns number of rows updated
   */
  async updatePricesBulk(
    updates: Array<{
      id: InvestmentId;
      current_price: number;
      price_updated_at: string;
    }>,
  ): Promise<number> {
    if (!Array.isArray(updates) || updates.length === 0) return 0;

    const result = await sql`
      UPDATE investments i
         SET current_price = u.current_price,
             price_updated_at = u.price_updated_at
        FROM UNNEST(${updates.map((u) => u.id)}::int[],
                    ${updates.map((u) => u.current_price)}::numeric[],
                    ${updates.map((u) => u.price_updated_at)}::timestamptz[])
             AS u(id, current_price, price_updated_at)
       WHERE i.id = u.id`.execute(db);
    return Number(result.numAffectedRows ?? 0n);
  },

  /** @returns TIMESTAMPTZ — a `Date`, not a string. */
  async getLatestPriceUpdatedAt(): Promise<Date | null> {
    const row = await checkedRow(
      latestPriceUpdatedAtRowSchema,
      db
        .selectFrom("investments")
        .select((eb) => eb.fn.max("price_updated_at").as("latest"))
        .where("is_active", "=", true)
        .where("price_provider", "is not", null)
        .where("price_provider", "<>", "manual"),
    );
    return row?.latest ?? null;
  },

  async hardDelete(id: InvestmentId): Promise<boolean> {
    const result = await db
      .deleteFrom("investments")
      .where("id", "=", id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  },
};

export default investmentRepository;
