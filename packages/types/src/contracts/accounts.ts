import { z } from "zod";

import {
  IdSchema,
  NumericSchema,
  WireLinkSchema,
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

/**
 * Wire contract for an account row. The scalar columns are accountRepository's
 * `COLUMNS` list; the balance and provenance fields are list-endpoint
 * enrichments from `accountService.list`. Required: `id`, `name`; the rest is
 * checked when present. The service emits the money figures as JSON numbers,
 * but the client also accepts NUMERIC strings there because `normalizeAccount`
 * coerces them.
 */
export const AccountSchema = z.looseObject({
  id: IdSchema,
  name: z.string(),
  display_name: z.string().nullable().optional(),
  institution: z.string().nullable().optional(),
  currency: z.string().optional(),
  type: AccountTypeSchema.optional(),
  liquidity_class: AccountLiquidityClassSchema.optional(),
  spendable: z.boolean().optional(),
  in_net_worth: z.boolean().optional(),
  tax_wrapper: AccountTaxWrapperSchema.optional(),
  owner: AccountOwnerSchema.optional(),
  multi_currency_cash: z.boolean().optional(),
  has_cash_sleeve: z.boolean().optional(),
  funding_account_id: IdSchema.nullable().optional(),
  is_active: z.boolean().optional(),
  closed_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().nullable().optional(),
  statement_balances: z
    .array(
      z.looseObject({
        currency: z.string(),
        balance: NumericSchema,
        balance_date: z.string(),
      }),
    )
    .optional(),
  computed_balance: NumericSchema.nullable().optional(),
  balance_parts: z
    .array(z.looseObject({ currency: z.string(), balance: NumericSchema }))
    .optional(),
  balance_incomplete: z.boolean().optional(),
  unconverted_currencies: z.array(z.string()).optional(),
  reconcilable_balance: NumericSchema.nullable().optional(),
  reconcilable_currency: z.string().optional(),
  drift: NumericSchema.nullable().optional(),
  anchor_date: z.string().optional(),
  post_anchor_count: z.number().int().nonnegative().optional(),
  has_transactions: z.boolean().optional(),
  links: z.array(WireLinkSchema).optional(),
});

/** `GET /api/accounts` — opt-in pagination. */
export const AccountListSchema = wireListOf(AccountSchema);
