import { protectPlannedExecutions } from "../repositories/plannedExecutionGuard.ts";
import { lockAccountsForLedgerMutation } from "../repositories/accountLifecycleLock.ts";
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

import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRows, compileQuery, db } from "../database/db.ts";
import type { BuiltQuery } from "../database/db.ts";
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
import {
  asCategoryId,
  asRecipientId,
  asTransactionId,
} from "@vision/types/brands";
import type { TagId } from "@vision/types/brands";
import type { QueryRunner } from "../types/rows.ts";
import { removeAttachmentFilesBestEffort } from "./attachmentCleanup.ts";

/** Run a built query on the caller's transaction client. */
async function runOn(client: QueryRunner, builder: BuiltQuery) {
  const compiled = compileQuery(builder);
  return client.query(compiled.sql, [...compiled.parameters]);
}

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
  const txIds = validateInt4Ids(transactionIds, "transaction_ids").map(
    asTransactionId,
  );
  if (txIds.length === 0) {
    throw new ValidationError("transaction_ids contains no valid IDs");
  }

  const addTagIds: TagId[] = [];
  const removeTagIds: TagId[] = [];
  const allUnknown: string[] = [];

  if (addSlugs.length > 0) {
    const rows = await checkedRows(
      tagSlugRowSchema,
      db
        .selectFrom("tags")
        .select(["id", "slug"])
        .where(sql<boolean>`slug = ANY(${addSlugs}::text[])`)
        .where("is_active", "=", true),
    );
    const found = new Map(rows.map((row) => [row.slug, row.id]));
    for (const s of addSlugs) {
      const id = found.get(s);
      if (id === undefined) allUnknown.push(s);
      else addTagIds.push(id);
    }
  }

  if (removeSlugs.length > 0) {
    const rows = await checkedRows(
      tagSlugRowSchema,
      db
        .selectFrom("tags")
        .select(["id", "slug"])
        .where(sql<boolean>`slug = ANY(${removeSlugs}::text[])`),
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
      const rows = await checkedRows(
        transactionIdRowSchema,
        db
          .insertInto("transaction_tags")
          .columns(["transaction_id", "tag_id"])
          .expression(
            sql`SELECT t_id, g_id
                FROM unnest(${txIds}::int[]) AS t(t_id)
                CROSS JOIN unnest(${addTagIds}::int[]) AS g(g_id)`,
          )
          .onConflict((oc) => oc.doNothing())
          .returning("transaction_id"),
        client,
      );
      added = rows.length;
      rows.forEach((row) => affectedTxIds.add(row.transaction_id));
    }

    if (removeTagIds.length > 0) {
      const rows = await checkedRows(
        transactionIdRowSchema,
        db
          .deleteFrom("transaction_tags")
          .where(sql<boolean>`transaction_id = ANY(${txIds}::int[])`)
          .where(sql<boolean>`tag_id = ANY(${removeTagIds}::int[])`)
          .returning("transaction_id"),
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
  ids?: number[] | undefined;
  filter?: BulkFilterInput | null | undefined;
  expectedCount?: number | undefined;
  fields: {
    category_id?: number | null | undefined;
    recipient_id?: number | undefined;
    is_active?: boolean | undefined;
  };
}): Promise<{ updated: number; requested: number; matched: number }> {
  if (fields.category_id != null) {
    const category = await db
      .selectFrom("categories")
      .select("id")
      .where("id", "=", asCategoryId(fields.category_id))
      .where("is_active", "=", true)
      .executeTakeFirst();
    if (!category) {
      throw new ValidationError(
        `Category ${fields.category_id} does not exist or is inactive`,
      );
    }
  }
  if (fields.recipient_id != null) {
    const recipient = await db
      .selectFrom("recipients")
      .select("id")
      .where("id", "=", asRecipientId(fields.recipient_id))
      .where("is_active", "=", true)
      .executeTakeFirst();
    if (!recipient) {
      throw new ValidationError(
        `Recipient ${fields.recipient_id} does not exist or is inactive`,
      );
    }
  }

  const txIds = await resolveBulkSelection(
    { ids, filter },
    { allowEmpty: expectedCount !== undefined },
  );

  // Presence drives the SET list (the route sends only valid values).
  const { category_id, recipient_id, is_active } = fields;
  const update = db
    .updateTable("transactions")
    .set({
      ...("category_id" in fields && {
        category_id: category_id == null ? null : asCategoryId(category_id),
      }),
      ...(recipient_id !== undefined && {
        recipient_id: asRecipientId(recipient_id),
      }),
      ...(is_active !== undefined && { is_active }),
      updated_at: sql<Date>`NOW()`,
    })
    .where(sql<boolean>`id = ANY(${txIds}::int[])`)
    .returning("id");

  const updated = await withTransaction(async (client) => {
    if ("is_active" in fields) await lockAccountsForLedgerMutation(client, txIds);
    const r = await runOn(client, update);
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
  ids?: number[] | undefined;
  filter?: BulkFilterInput | null | undefined;
  expectedCount?: number | undefined;
}): Promise<{ deleted: number; requested: number; matched: number }> {
  const txIds = await resolveBulkSelection(
    { ids, filter },
    { allowEmpty: expectedCount !== undefined },
  );

  const attachmentPaths =
    await attachmentRepository.listPathsByTransactionIds(txIds);
  const deleted = await withTransaction(async (client) => {
    await lockAccountsForLedgerMutation(client, txIds);
    await protectPlannedExecutions(txIds);
    const r = await runOn(
      client,
      db
        .deleteFrom("transactions")
        .where(sql<boolean>`id = ANY(${txIds}::int[])`)
        .returning("id"),
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
