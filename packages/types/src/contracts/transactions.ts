import { z } from "zod";

import { IdSchema, WireLinkSchema, wireListOf } from "./common.ts";

/** Fixture contract: the exact `TRANSACTION_STUB` body the MSW tests serve. */
export const TransactionItemSchema = z.strictObject({
  id: z.number().int().positive(),
  transaction_date: z.string(),
  bank_account: z.string(),
  recipient_id: z.number().int().positive().nullable(),
  recipient_name: z.string().nullable(),
  memo: z.string().nullable(),
  amount: z.number(),
  currency: z.string(),
  balance: z.number().nullable(),
  category_id: z.number().int().positive().nullable(),
  category_name: z.string().nullable(),
  comment: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

/** `TransactionTagRef` as `attachTagsToRows` projects it (no timestamps). */
export const TransactionTagRefSchema = z.looseObject({
  id: IdSchema,
  slug: z.string(),
  color: z.string().nullable(),
  is_active: z.boolean(),
});

/**
 * Wire contract for one row of `formatTransaction` (routes/transactions.ts).
 * NUMERIC columns (`amount`, `amount_eur`, `balance`, `running_balance`) are
 * converted to JSON numbers by the formatter. `bank_account` is nullable on the
 * wire (ADR-090 trade cash legs carry no label). Required: `id`,
 * `transaction_date`, `amount`; the rest is checked when present.
 */
export const TransactionSchema = z.looseObject({
  ...TransactionItemSchema.partial().shape,
  id: TransactionItemSchema.shape.id,
  transaction_date: TransactionItemSchema.shape.transaction_date,
  amount: TransactionItemSchema.shape.amount,
  bank_account: z.string().nullable().optional(),
  // NOT NULL since the ISO-4217 CHECK migration; a NULL currency is a
  // contract violation, not a legacy row to render as EUR (owner, 2026-10-09).
  currency: z.string().optional(),
  account_id: IdSchema.nullable().optional(),
  is_transfer: z.boolean().optional(),
  transfer_peer_id: IdSchema.nullable().optional(),
  transfer_source: z.string().nullable().optional(),
  amount_eur: z.number().optional(),
  running_balance: z.number().optional(),
  tags: z.array(TransactionTagRefSchema).optional(),
  links: z.array(WireLinkSchema).optional(),
});

/** `GET /api/transactions` (always paginated by the backend). */
export const TransactionListSchema = wireListOf(TransactionSchema);
