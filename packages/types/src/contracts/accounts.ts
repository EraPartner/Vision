import { z } from "zod";

import {
  CurrencyCodeSchema,
  IdSchema,
  WireDateSchema,
  WireLinkSchema,
  WireTimestampSchema,
  wireListOf,
} from "./common.ts";

export const AccountTypeSchema = z.enum([
  "checking",
  "savings",
  "brokerage",
  "crypto_exchange",
  "wallet",
  "pension",
  "liability",
]);
export const AccountLiquidityClassSchema = z.enum([
  "liquid",
  "semi_liquid",
  "illiquid",
]);
export const AccountTaxWrapperSchema = z.enum([
  "none",
  "pension",
  "tax_advantaged",
]);
export const AccountOwnerSchema = z.enum(["me", "partner", "joint"]);

/** accountRepository's `COLUMNS` list: every account read projects these. */
const accountColumns = {
  id: IdSchema,
  name: z.string(),
  display_name: z.string().nullable(),
  institution: z.string().nullable(),
  currency: CurrencyCodeSchema,
  type: AccountTypeSchema,
  liquidity_class: AccountLiquidityClassSchema,
  spendable: z.boolean(),
  in_net_worth: z.boolean(),
  tax_wrapper: AccountTaxWrapperSchema,
  owner: AccountOwnerSchema,
  multi_currency_cash: z.boolean(),
  has_cash_sleeve: z.boolean(),
  funding_account_id: IdSchema.nullable(),
  is_active: z.boolean(),
  closed_at: WireTimestampSchema.nullable(),
  created_at: WireTimestampSchema,
  updated_at: WireTimestampSchema,
};

/**
 * A single-account body (`GET /:id`, `POST`, `PATCH`): the columns plus the
 * route's `links: []`.
 */
export const AccountSchema = z.looseObject({
  ...accountColumns,
  links: z.array(WireLinkSchema),
});

const balancePartSchema = z.looseObject({
  currency: z.string(),
  balance: z.number(),
});

/**
 * One `accountService.list` item: the columns plus the balance and provenance
 * enrichments, all computed as JSON numbers by the service. `anchor_date` and
 * `post_anchor_count` are omitted when the account has no stamped anchor.
 * List items carry no per-item `links`.
 */
export const AccountListItemSchema = z.looseObject({
  ...accountColumns,
  has_transactions: z.boolean(),
  statement_balances: z.array(
    z.looseObject({
      currency: z.string(),
      balance: z.number(),
      balance_date: WireDateSchema,
    }),
  ),
  computed_balance: z.number(),
  balance_parts: z.array(balancePartSchema),
  balance_incomplete: z.boolean(),
  unconverted_currencies: z.array(z.string()),
  reconcilable_balance: z.number(),
  reconcilable_currency: z.string(),
  drift: z.number().nullable(),
  anchor_date: WireDateSchema.optional(),
  post_anchor_count: z.number().int().nonnegative().optional(),
});

/**
 * `GET /api/accounts` — opt-in pagination: `limit`/`offset` only when the
 * request paginated; the body-level `links` is always present.
 */
export const AccountListSchema = wireListOf(AccountListItemSchema).extend({
  links: z.array(WireLinkSchema),
});

const mergeReassignedSchema = z.looseObject({
  transactions: z.number().int().nonnegative(),
  planned: z.number().int().nonnegative(),
  portfolio: z.number().int().nonnegative(),
  funding: z.number().int().nonnegative(),
});

/** `GET /api/accounts/:id/portfolio-lot-retag-preview`. */
export const AccountPortfolioLotRetagPreviewSchema = z.looseObject({
  account_id: IdSchema,
  eligible_count: z.number().int().nonnegative(),
  transaction_ids: z.array(IdSchema),
  limit: z.number().int().positive(),
  links: z.array(WireLinkSchema),
});

/** `POST /api/accounts/:id/merge` — `mergeAccounts`. */
export const AccountMergeResultSchema = z.looseObject({
  into: IdSchema,
  merged: z.array(IdSchema),
  reassigned: mergeReassignedSchema,
  stampsInterleaved: z.boolean(),
  links: z.array(WireLinkSchema),
});

/** `GET /api/accounts/:id/merge-preview` — `previewMerge`. */
export const AccountMergePreviewSchema = z.looseObject({
  into: IdSchema,
  source: IdSchema,
  reassigned: mergeReassignedSchema,
  projectedBalance: z.number(),
  projectedBalanceCurrency: z.string(),
  balanceParts: z.array(balancePartSchema),
  projectedBalanceIncomplete: z.boolean(),
  unconvertedCurrencies: z.array(z.string()),
  stampsInterleaved: z.boolean(),
  openingAnchorCollision: z.boolean(),
  links: z.array(WireLinkSchema),
});

/**
 * `POST /api/accounts/:id/opening-balance` — `setOpeningBalance`. The anchor
 * row is a raw `RETURNING *` transactions row, so its NUMERIC `balance` is a
 * decimal string, not a number.
 */
export const OpeningBalanceResultSchema = z.looseObject({
  transaction: z
    .looseObject({
      id: IdSchema,
      balance: z.string().regex(/^-?\d+(\.\d+)?$/),
      transfer_source: z.literal("opening"),
    })
    .nullable(),
  warning: z.string().nullable(),
  links: z.array(WireLinkSchema),
});
