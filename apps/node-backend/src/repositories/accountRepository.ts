/**
 * Account Repository — data access for the accounts table (ADR-088).
 *
 * Accounts are the user's own accounts (distinct from recipient_bank_accounts,
 * which are counterparty IBANs). `name` is unique on its normalized form —
 * lower(btrim(name)), migration 0066 / ADR-088 addendum (D1) — while the stored
 * value keeps the user's casing for display. The flag columns
 * (type / liquidity_class / spendable / in_net_worth / tax_wrapper / owner /
 * multi_currency_cash / has_cash_sleeve) exist here from migration 0050; their
 * semantics are activated in ADR-089.
 */

import { sql } from "kysely";
import { query } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  accountBalanceQueryRowSchema,
  accountKeyRowSchema,
  accountRowSchema,
  countRowSchema,
  statementBalanceRowSchema,
} from "../database/rowSchemas.ts";
import {
  accountNameRowSchema,
  accountOwnerRowSchema,
} from "../database/rows/ledger.ts";
import {
  balanceProvenanceLateral,
  computedBalanceByCurrencyAggLateral,
} from "./accountBalanceSql.ts";
import { todayAppDateString } from "../lib/timezone.ts";
import { lockAccountFundingGraph } from "../lib/accountFundingGraphLock.ts";

import type { Insertable, Updateable } from "kysely";
import type { z } from "zod";
import type { Accounts } from "../database/schema.generated.ts";
import type { AccountId, CurrencyCode } from "@vision/types/brands";
import type {
  AccountBalanceQueryRow,
  AccountRow,
  QueryRunner,
} from "../types/rows.ts";

export type { AccountRow, AccountBalanceQueryRow };

/** A row of `account_statement_balances` as `upsertStatementBalance` returns it. */
export type StatementBalanceRow = z.output<typeof statementBalanceRowSchema>;

const COLUMN_LIST = [
  "id",
  "name",
  "display_name",
  "institution",
  "currency",
  "type",
  "liquidity_class",
  "spendable",
  "in_net_worth",
  "tax_wrapper",
  "owner",
  "multi_currency_cash",
  "has_cash_sleeve",
  "funding_account_id",
  "is_active",
  "closed_at",
  "created_at",
  "updated_at",
] as const;

const COLUMNS = sql.join(COLUMN_LIST.map((column) => sql.id(column)));

// Columns a caller may set on create/update. `name` is handled explicitly on
// create; everything else is optional and falls back to the DB default.
// `closed_at` is server-stamped by the service's lifecycle logic (D5) — it is
// writable here but never accepted from a request body.
const WRITABLE: ReadonlySet<string> = new Set([
  "name",
  "display_name",
  "institution",
  "currency",
  "type",
  "liquidity_class",
  "spendable",
  "in_net_worth",
  "tax_wrapper",
  "owner",
  "multi_currency_cash",
  "has_cash_sleeve",
  "funding_account_id",
  "is_active",
  "closed_at",
]);

/**
 * The defined, whitelisted fields of a create/update payload. accountService
 * validates the values with zod before they reach the repository.
 */
function writableFields(fields: Record<string, unknown>): Updateable<Accounts> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) => value !== undefined && WRITABLE.has(key),
    ),
  );
}

/**
 * SQL `btrim(x)` — strips ASCII space (U+0020) ONLY, exactly like the sync
 * trigger's `btrim(NEW.bank_account)`. Deliberately NOT `String#trim()`, which
 * strips all Unicode whitespace: a label ending in e.g. U+00A0 (NBSP) must
 * resolve to the SAME identity the trigger computes, or explicit resolution
 * and the trigger fork — two accounts minted for one label, and the trigger
 * overwrites the explicitly-written account_id with the other one.
 */
function sqlBtrim(s: unknown): string {
  return String(s).replace(/^ +| +$/g, "");
}

export const accountRepository = {
  /**
   * Resolve a caller-supplied canonical identity without minting an account.
   * @param id Possibly unvalidated request input; bound as a query parameter.
   */
  async findActiveId(
    id: unknown,
    { client }: { client?: QueryRunner | undefined } = {},
  ): Promise<AccountId | undefined> {
    const select = db
      .selectFrom("accounts")
      .select("id")
      .where("id", "=", sql<AccountId>`${id}`)
      .where("is_active", "=", true);
    const row = await checkedRow(
      accountKeyRowSchema,
      // Writers passing their transaction must retain the active-state check
      // until commit. Account closing takes FOR UPDATE before reading balances.
      client ? select.forShare() : select,
      client,
    );
    return row?.id;
  },

  /**
   * List raw account rows (optionally filtered by active status) with native
   * balance partitions, per-currency statement readings, provenance columns,
   * and `has_transactions`. Currency conversion, drift, and the public numeric
   * response shape belong to `accountService.list`.
   *
   * Multi-currency accounts: the anchor+delta computation is partitioned by
   * `transactions.currency` (`computedBalanceByCurrencyAggLateral`) and each
   * partition with an available rate is converted into the account's OWN
   * currency, at today's rate, before the per-account total is summed —
   * `computed_balance` stays a figure
   * denominated in `accounts.currency`, which is what every consumer (the hub
   * cards, the dashboard cards, `groupAccounts.sumConvertedBalances`, the
   * reconcile dialog) already assumes when it re-converts for display. The
   * single-partition form this replaced added a EUR amount to a USD amount as
   * bare numbers (100 EUR + 100 USD at 0.5 → 100 instead of 150). A
   * single-currency account has exactly one partition and is unaffected. A
   * partition without a usable rate is exposed in native units and excluded
   * from the explicitly incomplete converted total (ADR-127).
   *
   * `drift` is the statement figure minus the RECONCILIATION BASE — the balance
   * of the partition the statement figure is a statement for (`statementPartition`)
   * — never minus the FX-converted total, which would make the badge move with
   * the daily rate. It stays a native-currency figure, the same one
   * `reconcileService` acts on, so the badge and the reconcile dialog can never
   * disagree.
   *
   * That base is emitted alongside it as `reconcilable_balance` /
   * `reconcilable_currency`, because on a multi-currency account it is NOT
   * `computed_balance` (which is the converted all-currency total) and the
   * reconcile dialog must preview `typed reading − base`, not
   * `typed reading − computed_balance`. The three native figures on that dialog
   * satisfy `drift = statement reading − reconcilable_balance` by construction,
   * all denominated in `reconcilable_currency`.
   *
   * The repository returns the raw SQL rows, including `balance_parts`; the
   * service owns currency conversion and API shaping.
   *
   * `limit` is optional and defaults to unbounded — the accounts list has always
   * served every row and the hub UI has no paging, so only an explicit
   * limit/offset narrows it. The per-currency lateral is the
   * aggregated (one row per account) form precisely so LIMIT keeps counting
   * accounts rather than currency partitions.
   */
  async getAll({
    active = null,
    limit = null,
    offset = 0,
  }: {
    active?: boolean | null;
    limit?: number | null;
    offset?: number;
  } = {}): Promise<AccountBalanceQueryRow[]> {
    const asOfDate = sql`${todayAppDateString()}::date`;
    const activeFilter =
      active === true
        ? sql` AND a.is_active = true`
        : active === false
          ? sql` AND a.is_active = false`
          : sql``;
    const page =
      limit == null ? sql`` : sql` LIMIT ${limit} OFFSET ${offset ?? 0}`;
    return checkedRows(
      accountBalanceQueryRowSchema,
      sql`
      SELECT ${COLUMNS},
             lb.anchor_date,
             lb.post_anchor_count,
             bp.balance_parts,
             COALESCE(sb.statement_balances, '[]'::json) AS statement_balances,
             -- The ORDER BY steers the probe onto the (account_id, date) index:
             -- a bare EXISTS was planned as a sequential scan per account, which
             -- reads the whole ledger for every account that has no rows.
             (
               SELECT true FROM transactions t2
               WHERE t2.account_id = a.id AND t2.is_active = true
               ORDER BY t2.date DESC
               LIMIT 1
             ) IS NOT NULL AS has_transactions
      FROM accounts a
      -- lb stays the account-level (cross-currency) lateral for the PROVENANCE
      -- fields only: "as of {date} statement + {n} entries since" describes the
      -- account's stamping history, not a currency's. The balance and drift
      -- below come from the per-currency partitions.
      ${balanceProvenanceLateral({ asOfDate })}
      ${computedBalanceByCurrencyAggLateral({ account: sql`a.id`, asOfDate })}
      LEFT JOIN LATERAL (
        SELECT json_agg(
                 json_build_object(
                   'currency', s.currency,
                   'balance', s.balance,
                   'balance_date', to_char(s.balance_date, 'YYYY-MM-DD')
                 ) ORDER BY s.currency
               ) AS statement_balances
          FROM account_statement_balances s
         WHERE s.account_id = a.id
      ) sb ON TRUE
      WHERE 1=1${activeFilter} ORDER BY a.name${page}`,
    );
  },

  /**
   * Count accounts matching the active filter — the `total` for a paginated
   * list (the unpaginated path uses the returned row count instead).
   */
  async getCount({
    active = null,
  }: { active?: boolean | null } = {}): Promise<number> {
    let builder = db
      .selectFrom("accounts as a")
      .select(sql<string>`COUNT(*)`.as("count"));
    if (active !== null) builder = builder.where("a.is_active", "=", active);
    const row = await checkedRow(countRowSchema, builder);
    // COUNT(*) without GROUP BY always returns exactly one row.
    if (!row) throw new Error("account count returned no row");
    return parseInt(row.count, 10);
  },

  async getById(id: AccountId): Promise<AccountRow | undefined> {
    return checkedRow(
      accountRowSchema,
      db.selectFrom("accounts").select(COLUMN_LIST).where("id", "=", id),
    );
  },

  /** Every account's id and owner (me | partner | joint), closed accounts included. */
  async listOwners(): Promise<Array<{ id: AccountId; owner: string }>> {
    return checkedRows(
      accountOwnerRowSchema,
      db.selectFrom("accounts").select(["id", "owner"]),
    );
  },

  /** @param name Matched case/whitespace-insensitively (D1). */
  async getByName(name: string): Promise<AccountRow | undefined> {
    // Identity is case/whitespace-insensitive (D1) — match how the sync
    // trigger and resolveOrCreateByName resolve labels.
    return checkedRow(
      accountRowSchema,
      db
        .selectFrom("accounts")
        .select(COLUMN_LIST)
        .where(sql<string>`lower(btrim(name))`, "=", sql<string>`lower(btrim(${name}))`),
    );
  },

  /**
   * Serialize every mutation of the account funding graph. Callers must hold
   * this transaction-scoped lock before validating or changing a
   * funding_account_id edge. A single graph lock is deliberately coarse: the
   * graph is small, writes are rare, and partial row-lock protocols can miss a
   * dependent whose edge is repointed by an account merge.
   */
  async lockFundingGraphForMutation(): Promise<void> {
    await lockAccountFundingGraph(query);
  },

  /**
   * Insert an account. Only whitelisted, defined fields are written; everything
   * else falls back to the column default (e.g. type='checking', owner='me').
   */
  async create(fields: Record<string, unknown>): Promise<AccountRow> {
    const row = await checkedRow(
      accountRowSchema,
      db
        .insertInto("accounts")
        // accountService's create schema requires `name`.
        .values(writableFields(fields) as Insertable<Accounts>)
        .returning(COLUMN_LIST),
    );
    // A plain INSERT ... RETURNING yields exactly one row or throws.
    if (!row) throw new Error("account INSERT returned no row");
    return row;
  },

  /**
   * Update an account; returns the updated row, or undefined if not found.
   */
  async update(
    id: AccountId,
    fields: Record<string, unknown>,
  ): Promise<AccountRow | undefined> {
    const changes = writableFields(fields);
    if (Object.keys(changes).length === 0) return this.getById(id);

    return checkedRow(
      accountRowSchema,
      db
        .updateTable("accounts")
        .set({ ...changes, updated_at: sql<Date>`NOW()` })
        .where("id", "=", id)
        .returning(COLUMN_LIST),
    );
  },

  /**
   * Hard-delete an account. Raises Postgres 23503 if transactions or planned
   * transactions still reference it (account_id FK is ON DELETE RESTRICT) — the
   * caller turns that into a 409 (archive instead). Returns the id, or undefined.
   */
  async remove(id: AccountId): Promise<AccountId | undefined> {
    const row = await checkedRow(
      accountKeyRowSchema,
      db.deleteFrom("accounts").where("id", "=", id).returning("id"),
    );
    return row?.id ?? undefined;
  },

  /**
   * Lock the merge survivor and read the name the repoints stamp onto
   * `bank_account` (ADR-088). FOR UPDATE so concurrent merges serialize.
   */
  async lockByIdForMerge(
    id: AccountId,
  ): Promise<{ id: AccountId; name: string } | undefined> {
    return checkedRow(
      accountNameRowSchema,
      db
        .selectFrom("accounts")
        .select(["id", "name"])
        .where("id", "=", id)
        .forUpdate(),
    );
  },

  /**
   * Lock the merge sources; returns the ids that exist (caller diffs for 404s).
   */
  async lockByIdsForMerge(ids: AccountId[]): Promise<{ id: AccountId }[]> {
    return checkedRows(
      accountKeyRowSchema,
      db
        .selectFrom("accounts")
        .select("id")
        .where("id", "=", sql<AccountId>`ANY(${ids}::int[])`)
        .forUpdate(),
    );
  },

  /**
   * Accounts that used a merged source as their funding/settlement account.
   *
   * @returns rows repointed
   */
  async repointFundingAccount(
    targetId: AccountId,
    sourceIds: AccountId[],
  ): Promise<number> {
    const result = await db
      .updateTable("accounts")
      .set({ funding_account_id: targetId })
      .where("funding_account_id", "=", sql<AccountId>`ANY(${sourceIds}::int[])`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  },

  /**
   * Clear a statement anchor invalidated by an interleaved-stamp merge (§1 F2).
   * Per-row `balance` stamps are historical facts and stay untouched.
   *
   * @returns rows affected
   */
  async clearStatementAnchor(id: AccountId): Promise<number> {
    const result = await db
      .deleteFrom("account_statement_balances")
      .where("account_id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  },

  /** Store one authoritative statement reading. */
  async upsertStatementBalance(
    accountId: AccountId,
    currency: CurrencyCode,
    balance: number | string,
    balanceDate: string,
  ): Promise<StatementBalanceRow> {
    const row = await checkedRow(
      statementBalanceRowSchema,
      db
        .insertInto("account_statement_balances")
        .values({
          account_id: accountId,
          currency,
          balance,
          balance_date: balanceDate,
        })
        .onConflict((oc) =>
          oc.columns(["account_id", "currency"]).doUpdateSet((eb) => ({
            balance: eb.ref("excluded.balance"),
            balance_date: eb.ref("excluded.balance_date"),
          })),
        )
        .returning([
          "account_id",
          "currency",
          "balance",
          sql<string>`to_char(balance_date, 'YYYY-MM-DD')`.as("balance_date"),
        ]),
    );
    // An upsert ... RETURNING yields exactly one row or throws.
    if (!row) throw new Error("statement balance upsert returned no row");
    return row;
  },

  async deleteStatementBalance(
    accountId: AccountId,
    currency: CurrencyCode,
  ): Promise<number> {
    const result = await db
      .deleteFrom("account_statement_balances")
      .where("account_id", "=", accountId)
      .where("currency", "=", currency)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  },

  /**
   * Delete the merged-away sources. The account_id FKs are ON DELETE RESTRICT,
   * so this only succeeds once every reference has been repointed.
   *
   * @returns rows deleted
   */
  async deleteMergedSources(
    sourceIds: AccountId[],
    targetId: AccountId,
  ): Promise<number> {
    const result = await db
      .deleteFrom("accounts")
      .where("id", "=", sql<AccountId>`ANY(${sourceIds}::int[])`)
      .where("id", "<>", targetId)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  },

  /**
   * Resolve an account id by name, creating the row if absent. Mirrors the
   * dual-write trigger's normalization EXACTLY — identity is
   * lower(btrim(name)), D1, and the JS-side pre-trim is `sqlBtrim` (U+0020
   * only), never `String#trim()` — so explicit creation and trigger-driven
   * creation converge on the same row for every label, including ones padded
   * with non-ASCII whitespace. On conflict the existing row keeps its stored
   * casing (no-op update purely to RETURNING the id in one round-trip).
   *
   * @returns undefined when `name` is null or btrims to empty (the trigger's
   *   blank path — no account)
   */
  async resolveOrCreateByName(
    name: string | null | undefined,
    {
      multiCurrencyCash = false,
      client,
    }: { multiCurrencyCash?: boolean; client?: QueryRunner } = {},
  ): Promise<AccountId | undefined> {
    if (name == null) return undefined;
    const trimmed = sqlBtrim(name);
    if (!trimmed) return undefined;
    const row = await checkedRow(
      accountKeyRowSchema,
      db
        .insertInto("accounts")
        .values({
          name: trimmed,
          display_name: trimmed,
          multi_currency_cash: multiCurrencyCash,
        })
        .onConflict((oc) =>
          oc.expression(sql`lower(btrim(name))`).doUpdateSet({
            multi_currency_cash: sql<boolean>`accounts.multi_currency_cash OR EXCLUDED.multi_currency_cash`,
          }),
        )
        .returning("id"),
      client,
    );
    return row?.id;
  },
};

export default accountRepository;
