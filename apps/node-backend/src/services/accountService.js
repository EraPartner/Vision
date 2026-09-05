/**
 * Account Service — business logic + orchestration for accounts (ADR-088).
 *
 * Sits between routes and accountRepository so route files never reach the
 * data-access layer directly (vision-local/no-repo-direct-from-route, ADR-067).
 */

import { z } from "zod";
import accountRepository from "../repositories/accountRepository.js";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
} from "../middleware/errorHandler.js";
import {
  assertCurrency,
  validateNumber,
  validateId,
} from "../lib/validation.js";
import {
  loadCurrentRates,
  convertWithRates,
} from "./currency/currencyConversionService.js";
import { hasConversionRate } from "../lib/exchangeRates.js";
import { toDecimal, toNumber, roundToCents } from "../lib/money.js";
import { statementPartition } from "../repositories/accountBalanceSql.js";
import { withTransaction } from "../database/connection.js";

// Enum value sets — mirror migration 0050. Their semantics are activated in ADR-089.
export const ACCOUNT_TYPES = [
  "checking",
  "savings",
  "brokerage",
  "crypto_exchange",
  "wallet",
  "pension",
  "liability",
];
const LIQUIDITY_CLASSES = ["liquid", "semi_liquid", "illiquid"];
export const TAX_WRAPPERS = ["none", "pension", "tax_advantaged"];
const ACCOUNT_OWNERS = ["me", "partner", "joint"];

// Matches the 12-integer-digit ceiling of the money columns (NUMERIC(18,6)).
const MAX_STATEMENT_BALANCE = 1e12;

/* ── Zod schemas ───────────────────────────────────────────────────────────
 * Payloads are validated with zod (schema → safeParse → ValidationError), the
 * idiom established in settings.js/reports.js. The schemas are STRICT-strip:
 * unknown body fields are dropped (allowlist semantics — closed_at stays
 * server-stamped), explicit null survives to the repository as SQL NULL
 * (PATCH-to-clear), and absent keys stay absent so the repository SET builder
 * skips them. */

// An account label must be a non-empty string; stored trimmed.
const nameField = z
  .string({ error: "name is required and must be a non-empty string" })
  .refine(
    (s) => s.trim().length > 0,
    "name is required and must be a non-empty string",
  )
  .transform((s) => s.trim());

// Clearable free-text: null clears, strings are trimmed, anything else rejects.
/** @param {string} key */
const clearableStringField = (key) =>
  z
    .string({ error: `${key} must be a string` })
    .nullable()
    .transform((value) => (value === null ? null : value.trim()))
    .optional();

// Shared ISO-4217 guard; null/'' still reject here (an explicit currency key
// must carry a real code), matching the old inline regex.
const currencyField = z
  .unknown()
  .transform((value, ctx) => {
    let code;
    try {
      code = assertCurrency(value);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: err.message });
      return z.NEVER;
    }
    if (code === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "currency must be a 3-letter ISO code",
      });
      return z.NEVER;
    }
    return code;
  })
  .optional();

/**
 * @param {string} key
 * @param {string[]} allowed
 */
const enumField = (key, allowed) =>
  z
    .enum(allowed, { error: `${key} must be one of: ${allowed.join(", ")}` })
    .optional();

/** @param {string} key */
const boolField = (key) =>
  z.boolean({ error: `${key} must be a boolean` }).optional();

// FK reference: null clears; otherwise the shared strict id parse (the async
// existence check runs after parsing, see assertFundingAccountValid).
//
// validateId rather than `Number()`: the existence check only ever sees the
// coerced value, so '1e3' arrived as the real account 1000 and the account was
// funded from one the caller never named ('0x10' → 16, true → 1, [7] → 7 the
// same way). '7' and 7 still parse exactly as before.
const fundingAccountIdField = z
  .unknown()
  .transform((value, ctx) => {
    if (value === null) return null;
    const parsed = validateId(value, "funding_account_id");
    if (!parsed.valid) {
      ctx.addIssue({
        code: "custom",
        message: "funding_account_id must be a positive integer",
      });
      return z.NEVER;
    }
    return parsed.value;
  })
  .optional();

// Statement balance: null clears; otherwise Number() coercion bounded like the
// money columns (NUMERIC 12-integer-digit ceiling) via the shared guard — an
// unbounded 1e15 / JSON "Infinity" otherwise slid past a finite check and
// 500'd at the DB. Balances can be negative (liability), so bound the magnitude.
const statementBalanceField = z
  .unknown()
  .transform((value, ctx) => {
    if (value === null) return null;
    const result = validateNumber(value, {
      min: -MAX_STATEMENT_BALANCE,
      max: MAX_STATEMENT_BALANCE,
      fieldName: "statement_balance",
    });
    if (!result.valid) {
      ctx.addIssue({ code: "custom", message: result.error });
      return z.NEVER;
    }
    return result.value;
  })
  .optional();

// Strict YYYY-MM-DD shape (String() coercion first, as before); null clears.
const statementBalanceDateField = z
  .unknown()
  .transform((value, ctx) => {
    if (value === null) return null;
    const d = String(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    const year = match ? Number(match[1]) : 0;
    const month = match ? Number(match[2]) : 0;
    const day = match ? Number(match[3]) : 0;
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      !match ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      ctx.addIssue({
        code: "custom",
        message: "statement_balance_date must be a valid ISO date (YYYY-MM-DD)",
      });
      return z.NEVER;
    }
    return d;
  })
  .optional();

const statementReadingSchema = z.object({
  balance: statementBalanceField.unwrap(),
  date: statementBalanceDateField.unwrap(),
});

// Update: every field optional. Create: same rules, name required.
const accountUpdateSchema = z.object({
  name: nameField.optional(),
  display_name: clearableStringField("display_name"),
  institution: clearableStringField("institution"),
  currency: currencyField,
  type: enumField("type", ACCOUNT_TYPES),
  liquidity_class: enumField("liquidity_class", LIQUIDITY_CLASSES),
  tax_wrapper: enumField("tax_wrapper", TAX_WRAPPERS),
  owner: enumField("owner", ACCOUNT_OWNERS),
  spendable: boolField("spendable"),
  in_net_worth: boolField("in_net_worth"),
  multi_currency_cash: boolField("multi_currency_cash"),
  has_cash_sleeve: boolField("has_cash_sleeve"),
  is_active: boolField("is_active"),
  funding_account_id: fundingAccountIdField,
  statement_balance: statementBalanceField,
  statement_balance_date: statementBalanceDateField,
});

const accountCreateSchema = accountUpdateSchema.extend({ name: nameField });

/**
 * Validate + normalize an account payload. On create, name is required; on
 * update every field is optional. Returns only the fields that were provided.
 * @param {any} body unvalidated wire payload — zod does the actual validation.
 * @param {{ requireName: boolean }} opts
 */
function sanitize(body, { requireName }) {
  const schema = requireName ? accountCreateSchema : accountUpdateSchema;
  const result = schema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues
      .map((issue) =>
        issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
    throw new ValidationError(msg);
  }
  return result.data;
}

/**
 * A statement balance is only meaningful with its as-of date (ADR-094 drift
 * anchors on it). Enforced here for a friendly 4xx; migration 0065's CHECK
 * (chk_accounts_statement_balance_has_date) backstops at the DB.
 *
 * `balance` is `number|string` because callers pass either side of a "provided
 * vs. stored" ternary: a zod-sanitized incoming value (coerced to `number`) or
 * the value already on the row (`AccountRow.statement_balance`, pg NUMERIC —
 * a `string`). Only presence is checked here, so the numeric-vs-string
 * distinction doesn't matter to this function.
 * @param {number|string|null|undefined} balance
 * @param {string|null|undefined} date
 */
function assertStatementBalanceHasDate(balance, date) {
  if (balance != null && date == null) {
    throw new ValidationError(
      "statement_balance_date is required when statement_balance is set",
    );
  }
}

/**
 * A funding account must exist and cannot be the account itself (a self-funding
 * cycle), nor may it close a longer cycle (A→B→A, A→B→C→A). `sanitize` only
 * checks the value is a positive integer; this verifies the reference. The DB FK
 * (fk_accounts_funding_account) backstops races, but a nonexistent id would
 * otherwise surface as a raw 23503 → 500; we 400 here.
 *
 * Cycle detection walks the funding chain UPWARD from the proposed parent: if it
 * reaches `selfId`, the edge being written would close a loop. Two hazards shape
 * the loop:
 *  - The walk must terminate even though the stored data may ALREADY contain a
 *    cycle (this guard did not exist before), so visited ids are tracked and the
 *    walk stops on the first repeat rather than trusting a depth bound — a
 *    genuinely deep chain is then never falsely rejected, and a pre-existing
 *    loop that does not involve `selfId` is left alone for its own edit to fix.
 *  - On create there is no self id yet, so a brand-new account cannot be anyone's
 *    ancestor and the walk is skipped entirely.
 *
 * One `getById` per hop rather than a recursive CTE: funding chains are a
 * handful of hops at most, this is a write path already doing round-trips, and
 * it reuses the existing repository read instead of adding SQL surface.
 *
 * @param {number|null|undefined} fundingAccountId
 * @param {number|null} selfId  the account being updated (null on create)
 */
async function assertFundingAccountValid(fundingAccountId, selfId) {
  if (fundingAccountId == null) return;
  const self = selfId == null ? undefined : Number(selfId);
  if (self !== undefined && fundingAccountId === self) {
    throw new ValidationError(
      "funding_account_id cannot reference the account itself",
    );
  }
  const funding = await accountRepository.getById(fundingAccountId);
  if (!funding) {
    throw new ValidationError(
      `funding_account_id ${fundingAccountId} does not reference an existing account`,
    );
  }
  if (self === undefined) return;
  const seen = new Set([fundingAccountId]);
  let ancestorId =
    funding.funding_account_id == null
      ? undefined
      : Number(funding.funding_account_id);
  while (ancestorId !== undefined) {
    if (ancestorId === self) {
      throw new ValidationError(
        `funding_account_id ${fundingAccountId} would create a funding cycle`,
      );
    }
    if (seen.has(ancestorId)) return;
    seen.add(ancestorId);
    const ancestor = await accountRepository.getById(ancestorId);
    if (!ancestor) return;
    ancestorId =
      ancestor.funding_account_id == null
        ? undefined
        : Number(ancestor.funding_account_id);
  }
}

const accountService = {
  /**
   * List accounts (active=true|false|null for all) as `{items, total}`.
   *
   * `limit` is optional: absent (the default, and what every current caller
   * sends) means the full list, so `total` is just the row count and the extra
   * COUNT round-trip is skipped. A supplied limit/offset pages the rows while
   * `total` stays the full match count.
   */
  async list({ active = null, limit = null, offset = 0 } = {}) {
    const rows = await accountRepository.getAll({ active, limit, offset });
    // Fetch one cached rate table for the entire page. The service owns this
    // stateful conversion and the API-facing numeric shape; the repository
    // returns only database rows and native-currency partitions.
    const rates = await loadCurrentRates();
    const items = rows.map((/** @type {any} */ row) => {
      const {
        balance_parts: parts,
        statement_balances: rawStatements,
        ...rest
      } = row;
      /** @type {Array<{ currency: string, balance: string }>} */
      const partitions = parts ?? [];
      const accountCurrency = (row.currency || "EUR").toUpperCase();
      let total = toDecimal(0);
      /** @type {string[]} */
      const unconvertedCurrencies = [];
      for (const part of partitions) {
        const partCurrency = (part.currency || "EUR").toUpperCase();
        if (!hasConversionRate(partCurrency, accountCurrency, rates)) {
          unconvertedCurrencies.push(partCurrency);
          continue;
        }
        total = total.plus(
          toDecimal(
            convertWithRates(
              toNumber(toDecimal(part.balance)),
              partCurrency,
              accountCurrency,
              rates,
            ),
          ),
        );
      }
      const base = statementPartition(partitions, row.currency);
      const baseBalance = toNumber(roundToCents(toDecimal(base.balance)));
      const statementBalances = (rawStatements ?? []).map((statement) => ({
        currency: String(statement.currency).toUpperCase(),
        balance: toNumber(toDecimal(statement.balance)),
        balance_date: statement.balance_date,
      }));
      const selectedStatement = statementBalances.find(
        (statement) => statement.currency === base.currency,
      );
      const hasStatementCollection = rawStatements !== undefined;
      const hasAnyStatements = statementBalances.length > 0;
      const statementBalance =
        selectedStatement?.balance ??
        ((!hasAnyStatements || base.currency === accountCurrency) &&
        row.statement_balance != null
          ? toNumber(toDecimal(row.statement_balance))
          : null);
      return {
        ...rest,
        ...(hasStatementCollection || row.statement_balance !== undefined
          ? { statement_balance: statementBalance }
          : {}),
        ...(hasStatementCollection || row.statement_balance_date !== undefined
          ? {
              statement_balance_date:
                selectedStatement?.balance_date ??
                (!hasAnyStatements || base.currency === accountCurrency
                  ? row.statement_balance_date
                  : null),
            }
          : {}),
        ...(hasStatementCollection
          ? { statement_balances: statementBalances }
          : {}),
        computed_balance: toNumber(roundToCents(total)),
        balance_parts: partitions.map((part) => ({
          currency: (part.currency || "EUR").toUpperCase(),
          balance: toNumber(toDecimal(part.balance)),
        })),
        balance_incomplete: unconvertedCurrencies.length > 0,
        unconverted_currencies: unconvertedCurrencies,
        reconcilable_balance: baseBalance,
        reconcilable_currency: base.currency,
        drift:
          statementBalance == null
            ? null
            : toNumber(
                roundToCents(
                  toDecimal(statementBalance).minus(toDecimal(baseBalance)),
                ),
              ),
        anchor_date: row.anchor_date == null ? undefined : row.anchor_date,
        post_anchor_count:
          row.post_anchor_count == null
            ? undefined
            : parseInt(row.post_anchor_count, 10),
      };
    });
    const total =
      limit == null
        ? rows.length
        : await accountRepository.getCount({ active });
    return { items, total };
  },

  /** @param {number} id */
  async get(id) {
    const account = await accountRepository.getById(id);
    if (!account) throw new NotFoundError(`Account ${id} not found`);
    return account;
  },

  /** @param {any} body unvalidated wire payload — see `sanitize`. */
  async create(body) {
    const fields = sanitize(body, { requireName: true });
    const mutate = async () => {
      if ("funding_account_id" in fields) {
        await accountRepository.lockFundingGraphForMutation();
      }
      assertStatementBalanceHasDate(
        fields.statement_balance,
        fields.statement_balance_date,
      );
      await assertFundingAccountValid(fields.funding_account_id, null);
      try {
        return await accountRepository.create(fields);
      } catch (err) {
        if (err?.code === "23505")
          throw new ConflictError(
            `An account named "${fields.name}" already exists`,
          );
        // FK violation (e.g. funding_account_id lost a race with a delete) → 400.
        if (err?.code === "23503")
          throw new ValidationError(
            "funding_account_id does not reference an existing account",
          );
        throw err;
      }
    };
    return "funding_account_id" in fields ? withTransaction(mutate) : mutate();
  },

  /**
   * @param {number} id
   * @param {any} body unvalidated wire payload — see `sanitize`.
   */
  async update(id, body) {
    // Widened for closed_at: server-stamped below by the lifecycle logic (D5),
    // never part of the parsed payload.
    const fields =
      /** @type {ReturnType<typeof sanitize> & { closed_at?: Date | null }} */ (
        sanitize(body, { requireName: false })
      );
    const mutate = async () => {
      if ("funding_account_id" in fields) {
        await accountRepository.lockFundingGraphForMutation();
      }
      await assertFundingAccountValid(fields.funding_account_id, id);
      const touchesStatement =
        "statement_balance" in fields || "statement_balance_date" in fields;
      let current;
      if (touchesStatement || "is_active" in fields) {
        current = await accountRepository.getById(id);
        if (!current) throw new NotFoundError(`Account ${id} not found`);
      }
      // Partial PATCH: validate the merged state, not just the provided keys —
      // e.g. setting a balance while the stored date is NULL must still fail.
      if (touchesStatement) {
        assertStatementBalanceHasDate(
          "statement_balance" in fields
            ? fields.statement_balance
            : current.statement_balance,
          "statement_balance_date" in fields
            ? fields.statement_balance_date
            : current.statement_balance_date,
        );
      }
      // Lifecycle (ADR-088 addendum, D5): closing stamps closed_at once (a
      // redundant re-archive keeps the original timestamp); reactivating clears
      // it. Server-stamped only — sanitize() never accepts closed_at from the body.
      if (fields.is_active === false && current.is_active) {
        fields.closed_at = new Date();
        // §1 F3 aggregate semantics: `in_net_worth` governs aggregates,
        // `is_active` governs UI listing — so closing an account also drops it
        // from every aggregate (net worth, bank-balances widget). An explicit
        // in_net_worth in the same PATCH wins (respect
        // explicit intent). Reactivating deliberately does NOT auto-restore
        // in_net_worth: whether a reopened account should count again is a user
        // decision, made explicitly via PATCH { in_net_worth: true }.
        if (!("in_net_worth" in fields)) fields.in_net_worth = false;
      } else if (fields.is_active === true) {
        fields.closed_at = null;
      }
      let updated;
      try {
        updated = await accountRepository.update(id, fields);
      } catch (err) {
        if (err?.code === "23505")
          throw new ConflictError(
            `An account named "${fields.name}" already exists`,
          );
        if (err?.code === "23503")
          throw new ValidationError(
            "funding_account_id does not reference an existing account",
          );
        throw err;
      }
      if (!updated) throw new NotFoundError(`Account ${id} not found`);
      return updated;
    };
    return "funding_account_id" in fields ? withTransaction(mutate) : mutate();
  },

  /** Replace one currency's authoritative statement reading. */
  async setStatementBalance(id, currencyInput, body) {
    const account = await accountRepository.getById(id);
    if (!account) throw new NotFoundError(`Account ${id} not found`);
    const currency = assertCurrency(currencyInput);
    const parsed = statementReadingSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.balance == null ||
      parsed.data.date == null
    ) {
      const detail = parsed.success
        ? "balance and date are required"
        : parsed.error.issues.map((issue) => issue.message).join("; ");
      throw new ValidationError(detail);
    }
    return accountRepository.upsertStatementBalance(
      id,
      currency,
      parsed.data.balance,
      parsed.data.date,
    );
  },

  /** Remove one currency's statement reading. */
  async removeStatementBalance(id, currencyInput) {
    const account = await accountRepository.getById(id);
    if (!account) throw new NotFoundError(`Account ${id} not found`);
    const currency = assertCurrency(currencyInput);
    const removed = await accountRepository.deleteStatementBalance(
      id,
      currency,
    );
    if (!removed) {
      throw new NotFoundError(
        `Account ${id} has no ${currency} statement balance`,
      );
    }
    return { account_id: id, currency };
  },

  /**
   * Hard-delete an account. Accounts protect history: delete is only possible
   * with zero referencing rows (FK ON DELETE RESTRICT); otherwise a 409 routes
   * the caller to the close flow (lifecycle D5: active → closed → deleted).
   */
  /** @param {number} id */
  async remove(id) {
    return withTransaction(async () => {
      await accountRepository.lockFundingGraphForMutation();
      let removed;
      try {
        removed = await accountRepository.remove(id);
      } catch (err) {
        if (err?.code === "23503") {
          throw new ConflictError(
            `Account ${id} still has activity referencing it and cannot be deleted. Close the account instead.`,
          );
        }
        throw err;
      }
      if (!removed) throw new NotFoundError(`Account ${id} not found`);
      return removed;
    });
  },
};

export default accountService;

export { accountService };
