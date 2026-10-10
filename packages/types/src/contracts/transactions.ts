import { z } from "zod";

import {
  CurrencyCodeSchema,
  IdSchema,
  WireDateSchema,
  WireLinkSchema,
  WireTimestampSchema,
  wirePageOf,
} from "./common.ts";

/** `TransactionTagRef` as `attachTagsToRows` projects it (no timestamps). */
export const TransactionTagRefSchema = z.looseObject({
  id: IdSchema,
  slug: z.string(),
  color: z.string().nullable(),
  is_active: z.boolean(),
});

/** `transactions.transfer_source` (`chk_transactions_transfer_source`). */
export const TransferSourceSchema = z.enum([
  "auto",
  "manual",
  "opening",
  "adjustment",
  "brokerage",
]);

/**
 * One row of `formatTransaction` (routes/transactions.ts), the body of the
 * list, detail and PATCH reads. NUMERIC columns (`amount`, `amount_eur`,
 * `balance`, `running_balance`) are converted to JSON numbers by the
 * formatter. `bank_account` is `accounts.name` over a LEFT JOIN, so it is null
 * when `account_id` is (ADR-090 trade cash legs). `currency` is NOT NULL since
 * the ISO-4217 CHECK migration: a null currency is a contract violation, not a
 * legacy row to render as EUR (owner, 2026-10-09). `running_balance` is only
 * present on `include_balance=true` list reads.
 */
const transactionFields = {
  id: IdSchema,
  transaction_date: WireDateSchema,
  bank_account: z.string().nullable(),
  account_id: IdSchema.nullable(),
  is_transfer: z.boolean(),
  transfer_peer_id: IdSchema.nullable(),
  transfer_source: TransferSourceSchema.nullable(),
  recipient_id: IdSchema,
  recipient_name: z.string().nullable(),
  memo: z.string().nullable(),
  amount: z.number(),
  amount_eur: z.number(),
  currency: CurrencyCodeSchema,
  balance: z.number().nullable(),
  running_balance: z.number().optional(),
  category_id: IdSchema.nullable(),
  category_name: z.string().nullable(),
  comment: z.string().nullable(),
  tags: z.array(TransactionTagRefSchema),
  is_active: z.boolean(),
  created_at: WireTimestampSchema.nullable(),
  updated_at: WireTimestampSchema,
  links: z.array(WireLinkSchema),
};

/** Fixture contract: the exact `TRANSACTION_STUB` body the MSW tests serve. */
export const TransactionItemSchema = z.strictObject(transactionFields);

/** Wire contract for one `formatTransaction` row. */
export const TransactionSchema = z.looseObject(transactionFields);

/** `POST /api/transactions`: the formatted row plus the auto-link outcome. */
export const TransactionCreatedSchema = TransactionSchema.extend({
  auto_linked: IdSchema.nullable(),
});

/** `GET /api/transactions` (always paginated by the backend). */
export const TransactionListSchema = wirePageOf(TransactionSchema);

/** `POST /api/transactions/bulk-delete` — `bulkDeleteTransactions` counts. */
export const BulkDeleteResultSchema = z.looseObject({
  deleted: z.number().int().nonnegative(),
  requested: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
});

/** `POST /api/transactions/bulk-update` — `bulkUpdateTransactions` counts. */
export const BulkUpdateResultSchema = z.looseObject({
  updated: z.number().int().nonnegative(),
  requested: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
});
