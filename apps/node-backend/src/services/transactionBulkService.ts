/**
 * Transaction bulk-action service — business logic for the
 * POST /api/transactions/bulk-{tag,update,delete} endpoints.
 *
 * Moved out of routes/transactions.js so the route layer keeps only request
 * parsing/validation and response shaping (ADR-067 route → service boundary).
 * Selection resolution (`{ ids } | { filter }`) stays in bulkSelection.js; this
 * module owns the DB-backed validation (tag-slug and FK existence checks), the
 * atomic writes, and the post-write reconcile scheduling.
 */

import { query as dbQuery, withTransaction } from "../database/connection.ts";
import { queryRows } from "../database/rowContracts.ts";
import {
  tagSlugRowSchema,
  transactionIdRowSchema,
} from "../database/rows/ledger.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import { validateInt4Ids } from "../lib/filterBuilder.ts";
import { resolveBulkSelection } from "./bulkSelection.ts";
import type { BulkFilterInput } from "./bulkSelection.ts";
import { scheduleReconcile } from "./transferReconciliationService.ts";
import { attachmentRepository } from "./attachmentRecordService.ts";
import { removeAttachmentFilesBestEffort } from "./attachmentCleanup.ts";

/**
 * Add and/or remove tags (by slug) on a set of transactions.
 *
 * Slugs are resolved to ids up front — adds must reference ACTIVE tags,
 * removes may reference inactive ones — and any unknown slug fails the whole
 * request before a single row is written. Both writes run in one transaction;
 * `added`/`removed` count junction rows actually inserted (ON CONFLICT DO
 * NOTHING dedups) / deleted, and `transactions_affected` counts distinct
 * transactions touched by either.
 */
export async function bulkTagTransactions({
  transactionIds,
  addSlugs,
  removeSlugs,
}: {
  transactionIds: unknown[];
  addSlugs: string[];
  removeSlugs: string[];
}): Promise<{ added: number; removed: number; transactions_affected: number }> {
  // Validated as sent — see the note in bulkSelection.js: the `.map(Number)`
  // that used to sit here turned '1e3' into id 1000 and true into id 1.
  const txIds = validateInt4Ids(transactionIds, "transaction_ids");
  if (txIds.length === 0) {
    throw new ValidationError("transaction_ids contains no valid IDs");
  }

  const addTagIds: number[] = [];
  const removeTagIds: number[] = [];
  const allUnknown: string[] = [];

  if (addSlugs.length > 0) {
    const rows = await queryRows(
      tagSlugRowSchema,
      "SELECT id, slug FROM tags WHERE slug = ANY($1::text[]) AND is_active = true",
      [addSlugs],
    );
    const found = new Map(rows.map((row) => [row.slug, row.id]));
    for (const s of addSlugs) {
      const id = found.get(s);
      if (id === undefined) allUnknown.push(s);
      else addTagIds.push(id);
    }
  }

  if (removeSlugs.length > 0) {
    const rows = await queryRows(
      tagSlugRowSchema,
      "SELECT id, slug FROM tags WHERE slug = ANY($1::text[])",
      [removeSlugs],
    );
    const found = new Map(rows.map((row) => [row.slug, row.id]));
    for (const s of removeSlugs) {
      const id = found.get(s);
      if (id === undefined) allUnknown.push(s);
      else removeTagIds.push(id);
    }
  }

  if (allUnknown.length > 0) {
    throw new ValidationError(
      `Unknown or inactive tags: ${allUnknown.join(", ")}`,
    );
  }

  const result = await withTransaction(async (client) => {
    let added = 0;
    let removed = 0;
    const affectedTxIds = new Set<number>();

    if (addTagIds.length > 0) {
      const rows = await queryRows(
        transactionIdRowSchema,
        `INSERT INTO transaction_tags (transaction_id, tag_id)
         SELECT t_id, g_id
         FROM unnest($1::int[]) AS t(t_id)
         CROSS JOIN unnest($2::int[]) AS g(g_id)
         ON CONFLICT DO NOTHING
         RETURNING transaction_id`,
        [txIds, addTagIds],
        client,
      );
      added = rows.length;
      rows.forEach((row) => affectedTxIds.add(row.transaction_id));
    }

    if (removeTagIds.length > 0) {
      const rows = await queryRows(
        transactionIdRowSchema,
        `DELETE FROM transaction_tags
         WHERE transaction_id = ANY($1::int[]) AND tag_id = ANY($2::int[])
         RETURNING transaction_id`,
        [txIds, removeTagIds],
        client,
      );
      removed = rows.length;
      rows.forEach((row) => affectedTxIds.add(row.transaction_id));
    }

    return { added, removed, transactions_affected: affectedTxIds.size };
  });

  scheduleReconcile();
  return result;
}

/**
 * Apply one shared update (category, recipient, is_active) to a set of
 * transactions selected by `ids` or `filter`.
 *
 * `fields` must already be sanitized by the route's zod schema: only the
 * allow-listed keys, present-with-valid-value only (presence drives the SET
 * clause construction). FK targets are validated up front so the entire batch
 * fails atomically on the first invalid reference.
 *
 * @returns reconciliation counts
 */
export async function bulkUpdateTransactions({
  ids,
  filter,
  fields,
  expectedCount,
}: {
  ids?: number[];
  filter?: BulkFilterInput | null;
  expectedCount?: number;
  fields: {
    category_id?: number | null;
    recipient_id?: number;
    is_active?: boolean;
  };
}): Promise<{ updated: number; requested: number; matched: number }> {
  if (fields.category_id != null) {
    const r = await dbQuery(
      "SELECT id FROM categories WHERE id = $1 AND is_active = true",
      [fields.category_id],
    );
    if (r.rows.length === 0) {
      throw new ValidationError(
        `Category ${fields.category_id} does not exist or is inactive`,
      );
    }
  }
  if (fields.recipient_id != null) {
    const r = await dbQuery(
      "SELECT id FROM recipients WHERE id = $1 AND is_active = true",
      [fields.recipient_id],
    );
    if (r.rows.length === 0) {
      throw new ValidationError(
        `Recipient ${fields.recipient_id} does not exist or is inactive`,
      );
    }
  }

  const txIds = await resolveBulkSelection(
    { ids, filter },
    { allowEmpty: expectedCount !== undefined },
  );

  const setClauses: string[] = [];
  const params: Array<number[] | number | boolean | null | undefined> = [txIds];
  let p = 2;
  if ("category_id" in fields) {
    setClauses.push(`category_id = $${p++}`);
    params.push(fields.category_id);
  }
  if ("recipient_id" in fields) {
    setClauses.push(`recipient_id = $${p++}`);
    params.push(fields.recipient_id);
  }
  if ("is_active" in fields) {
    setClauses.push(`is_active = $${p}`);
    params.push(fields.is_active);
  }
  setClauses.push("updated_at = NOW()");

  const updated = await withTransaction(async (client) => {
    const r = await client.query(
      `UPDATE transactions SET ${setClauses.join(", ")} WHERE id = ANY($1::int[]) RETURNING id`,
      params,
    );
    return r.rows.length;
  });

  if (updated > 0) scheduleReconcile();
  return {
    updated,
    requested: expectedCount ?? txIds.length,
    matched: txIds.length,
  };
}

/**
 * Hard-delete a set of transactions selected by `ids` or `filter`.
 *
 * CASCADE on transaction_tags / transaction_splits / attachments handles
 * dependent rows; raw_transactions and import_batches use SET NULL. Attachment
 * file paths are collected BEFORE the delete (the CASCADE removes the rows
 * that know them) and removed best-effort after the commit.
 *
 * @returns reconciliation counts
 */
export async function bulkDeleteTransactions({
  ids,
  filter,
  expectedCount,
}: {
  ids?: number[];
  filter?: BulkFilterInput | null;
  expectedCount?: number;
}): Promise<{ deleted: number; requested: number; matched: number }> {
  const txIds = await resolveBulkSelection(
    { ids, filter },
    { allowEmpty: expectedCount !== undefined },
  );

  const attachmentPaths =
    await attachmentRepository.listPathsByTransactionIds(txIds);
  const deleted = await withTransaction(async (client) => {
    const r = await client.query(
      `DELETE FROM transactions WHERE id = ANY($1::int[]) RETURNING id`,
      [txIds],
    );
    return r.rows.length;
  });

  if (deleted > 0) {
    await removeAttachmentFilesBestEffort(attachmentPaths);
    scheduleReconcile();
  }
  return {
    deleted,
    requested: expectedCount ?? txIds.length,
    matched: txIds.length,
  };
}
