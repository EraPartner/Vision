/**
 * Split routes - transaction splitting and debt tracking.
 *
 * Bodies are validated with zod (schema → safeParse → ValidationError), the
 * idiom established in settings.js/reports.js. Schemas are LOOSE and forward
 * raw values (the repos take the coercion decisions); id bridges reuse
 * validateId so every id surface keeps the same strict accepted shapes.
 */

import { Router } from "express";
import type { ExpressRequest } from "../types/express.ts";
import { z } from "zod";
import splitService from "../services/splitService.js";
import { rateLimiter } from "../middleware/rateLimiter.ts";
import {
  BULK_SPLIT_MODES,
  type BulkSplitMode,
} from "../lib/calculations/splits.ts";
import {
  validateIdParam,
  validateId,
  assertIdParam,
} from "../middleware/validation.ts";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";
import { escapeCsvValue } from "../lib/csv.ts";
import { listBody, parseOptionalPagination } from "../lib/pagination.ts";

/** The row shape yielded by splitService.getOwedExportRowsByRecipient. */
type OwedExportRow = Awaited<
  ReturnType<typeof splitService.getOwedExportRowsByRecipient>
>[number];

const router = Router();

const OWED_EXPORT_HEADER =
  "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment";

// Structural request type: assertIdParam requires it (Express 5's
// ParamsDictionary also admits string[] wildcard params). resolveActor below
// uses it too, because the legacy checkJs program cannot see @types/express.
function parseRouteId(req: ExpressRequest): number {
  return assertIdParam(req);
}

function buildOwedExportCsvRow(row: OwedExportRow): string {
  return [
    escapeCsvValue(row.date),
    escapeCsvValue(row.bank_account),
    escapeCsvValue(row.recipient_name),
    escapeCsvValue(row.memo),
    escapeCsvValue(row.amount),
    escapeCsvValue(row.currency),
    escapeCsvValue(row.balance),
    escapeCsvValue(row.category_name),
    escapeCsvValue(row.comment),
  ].join(",");
}

function buildOwedExportCsv(rows: OwedExportRow[]): string {
  const csvRows = rows.map(buildOwedExportCsvRow);
  return [OWED_EXPORT_HEADER, ...csvRows].join("\n");
}

function buildOwedExportFilename(recipientId: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `owed_transactions_recipient_${recipientId}_${timestamp}.csv`;
}

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

// Reuses validateId so the accepted id shapes stay identical to the route
// layer's (a plain digit string or integer number, 1..2^31-1 — no trailing
// garbage, decimals or exponents); the coerced integer replaces the raw input.
const validatedIdField = (field: string) =>
  z.unknown().transform((value, ctx) => {
    const result = validateId(value, field);
    if (!result.valid) {
      ctx.addIssue({ code: "custom", message: result.error });
      return z.NEVER;
    }
    return result.value;
  });

// One /batch row. A row that fails this schema rejects the WHOLE request with
// a 400 naming the offending index — bulk writes are all-or-nothing, matching
// the transactions.js bulk-tag/bulk-update pattern (validate everything up
// front, then write). Finite non-positive amounts still parse here (the repo
// rejects them), so valid batches normalize exactly as before.
const batchSplitRowSchema = z.object({
  recipient_id: validatedIdField("recipient_id"),
  amount: z.unknown().transform((value, ctx) => {
    const num = Number(value);
    if (value == null || !Number.isFinite(num)) {
      ctx.addIssue({
        code: "custom",
        message: "amount must be a finite number",
      });
      return z.NEVER;
    }
    return num;
  }),
  note: z.unknown().optional(),
});

// POST body: raw values are forwarded to the repository unchanged (only the
// audit payload coerces amount), so the checks refine without transforming.
const createSplitSchema = z.looseObject({}).superRefine((data, ctx) => {
  if (!data.transaction_id || !data.recipient_id || data.amount == null) {
    ctx.addIssue({
      code: "custom",
      message: "Missing required fields: transaction_id, recipient_id, amount",
    });
    return;
  }
  // FK ids were only truthiness-checked before, so a non-integer (e.g. "abc")
  // reached Postgres as an FK/type error and surfaced as a raw 500.
  const txIdCheck = validateId(data.transaction_id, "transaction_id");
  if (!txIdCheck.valid)
    ctx.addIssue({ code: "custom", message: txIdCheck.error });
  const recIdCheck = validateId(data.recipient_id, "recipient_id");
  if (!recIdCheck.valid)
    ctx.addIssue({ code: "custom", message: recIdCheck.error });
  if (!Number.isFinite(Number(data.amount))) {
    ctx.addIssue({ code: "custom", message: "amount must be a finite number" });
  }
});

const batchSplitsSchema = z.looseObject({}).superRefine((data, ctx) => {
  if (
    !data.transaction_id ||
    !Array.isArray(data.splits) ||
    data.splits.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Missing required fields: transaction_id, splits[]",
    });
    return;
  }
  const txIdCheck = validateId(data.transaction_id, "transaction_id");
  if (!txIdCheck.valid)
    ctx.addIssue({ code: "custom", message: txIdCheck.error });
});

// POST /bulk: one recipient, one preset, many transactions. Ids reuse
// validateId (same accepted shapes as every other id surface); the array cap
// mirrors transactions/bulk-tag. Like /batch, a malformed id rejects the
// whole request before any write.
const BULK_SPLIT_MAX_IDS = 500;

const bulkSplitSchema = z.object({
  transaction_ids: z
    .array(z.unknown(), {
      error: `transaction_ids must be a non-empty array of up to ${BULK_SPLIT_MAX_IDS} IDs`,
    })
    .min(1, {
      error: `transaction_ids must be a non-empty array of up to ${BULK_SPLIT_MAX_IDS} IDs`,
    })
    .max(BULK_SPLIT_MAX_IDS, {
      error: `transaction_ids must be a non-empty array of up to ${BULK_SPLIT_MAX_IDS} IDs`,
    })
    .transform((ids, ctx) => {
      const prepared: number[] = [];
      const rejected: string[] = [];
      ids.forEach((id, index) => {
        const check = validateId(id, `transaction_ids[${index}]`);
        if (check.valid) prepared.push(check.value);
        else rejected.push(check.error);
      });
      if (rejected.length > 0) {
        ctx.addIssue({ code: "custom", message: rejected.join(", ") });
        return z.NEVER;
      }
      return prepared;
    }),
  recipient_id: validatedIdField("recipient_id"),
  mode: z.unknown().transform((value, ctx) => {
    if (
      typeof value !== "string" ||
      !(BULK_SPLIT_MODES as readonly string[]).includes(value)
    ) {
      ctx.addIssue({
        code: "custom",
        message: `mode must be one of: ${BULK_SPLIT_MODES.join(", ")}`,
      });
      return z.NEVER;
    }
    return value as BulkSplitMode;
  }),
  note: z.string().max(500).optional(),
});

const payBodySchema = z.looseObject({}).superRefine((data, ctx) => {
  if (
    data.amount == null ||
    !Number.isFinite(Number(data.amount)) ||
    Number(data.amount) <= 0
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Payment amount must be a positive number",
    });
  }
});

// The loose body schemas forward raw values, so their inferred field types are
// `unknown`; these describe what superRefine has checked by the time a route
// reads them (validated ids may still be digit strings, forwarded unchanged).
interface CreateSplitBody {
  [key: string]: unknown;
  transaction_id: number;
  recipient_id: number;
  amount: number | string;
  note?: string | null;
}

interface BatchSplitsBody {
  [key: string]: unknown;
  transaction_id: number;
  splits: unknown[];
}

interface PayBody {
  [key: string]: unknown;
  amount: number | string;
  note?: string | null;
  paid_at?: string | null;
}

function formatIssues(error: z.ZodError, separator: string): string {
  return error.issues
    .map((issue) =>
      issue.path.length
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join(separator);
}

// schema → safeParse → joined issues → ValidationError (settings.js idiom).
function parseSplitsBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(formatIssues(result.error, "; "));
  }
  return result.data;
}

// All-or-nothing: every row must parse. A malformed row used to be silently
// dropped and the rest committed, so a client could not tell that part of its
// batch never landed; now any bad row aborts the request before a single write.
// Every offending row is collected first so the 400 names them all — one
// round-trip to fix the whole payload, rather than one per bad row.
function normalizeBatchSplitInputs(
  splits: unknown[],
): z.infer<typeof batchSplitRowSchema>[] {
  const prepared: z.infer<typeof batchSplitRowSchema>[] = [];
  const rejected: string[] = [];

  splits.forEach((split, index) => {
    const result = batchSplitRowSchema.safeParse(split);
    if (result.success) prepared.push(result.data);
    else
      rejected.push(`splits[${index}] (${formatIssues(result.error, ", ")})`);
  });

  if (rejected.length > 0) {
    throw new ValidationError(
      `Invalid splits, no splits were created: ${rejected.join("; ")}`,
    );
  }
  return prepared;
}

function resolveActor(req: ExpressRequest): string | null {
  return req.get("x-actor") || null;
}

// Pagination is opt-in on every list below: without limit/offset the whole
// collection is returned exactly as before, so no existing client is truncated.
//
// The owed summary is derived in JS after the aggregate (see the repository),
// so this one pages the computed array rather than the query; `total` is still
// the full group count.
router.get("/owed", async (req, res) => {
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const summary = await splitService.getOwedSummary();
  const items = page
    ? summary.slice(page.offset, page.offset + page.limit)
    : summary;
  res.ok(listBody(items, summary.length, page));
});

router.get("/owed/:id", validateIdParam, async (req, res) => {
  const recipientId = parseRouteId(req);
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const splits = await splitService.getOwedByRecipient(recipientId, page ?? {});
  const total = page
    ? await splitService.countOwedByRecipient(recipientId)
    : splits.length;
  res.ok(listBody(splits, total, page));
});

router.get("/owed/:id/export/csv", validateIdParam, async (req, res) => {
  const recipientId = parseRouteId(req);
  const rows = await splitService.getOwedExportRowsByRecipient(recipientId);
  if (rows.length === 0)
    throw new NotFoundError(
      "No unsettled owed transactions found for recipient",
    );

  const csv = buildOwedExportCsv(rows);
  const filename = buildOwedExportFilename(recipientId);

  // Binary/text download: envelope (ADR-026) does not apply — client receives
  // the CSV body as-is via Content-Disposition: attachment.
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  res.send(csv);
});

router.get("/transaction/:id", validateIdParam, async (req, res) => {
  const transactionId = parseRouteId(req);
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const splits = await splitService.getSplitsByTransaction(
    transactionId,
    page ?? {},
  );
  const total = page
    ? await splitService.countSplitsByTransaction(transactionId)
    : splits.length;
  res.ok(listBody(splits, total, page));
});

router.post("/", async (req, res) => {
  // createSplitSchema is `z.looseObject({})` — raw values forwarded unchanged
  // (see module doc); superRefine validates shape/presence but zod's inferred
  // type is still `unknown` per field. The cast documents what's actually
  // been checked by the time this line runs.
  const { transaction_id, recipient_id, amount, note } = parseSplitsBody(
    createSplitSchema,
    req.body,
  ) as CreateSplitBody;

  const split = await splitService.createSplitAtomic({
    transaction_id,
    recipient_id,
    amount,
    note,
    actor: resolveActor(req),
  });
  res.status(201);
  res.ok(split);
});

router.post("/batch", async (req, res) => {
  // batchSplitsSchema is `z.looseObject({})` — transaction_id and the
  // non-empty splits array are validated by superRefine but zod's inferred
  // type is still `unknown`; the cast documents what has been checked.
  const { transaction_id, splits } = parseSplitsBody(
    batchSplitsSchema,
    req.body,
  ) as BatchSplitsBody;

  // Throws on any malformed row, so nothing is written unless every row is
  // valid; a batch whose rows ALL fail is covered by the same 400 (it can
  // never reach the repository as an empty `splits`, since the body schema
  // already rejects an empty array).
  const preparedSplits = normalizeBatchSplitInputs(splits);
  // preparedSplits rows are { recipient_id: number, amount: number,
  // note?: unknown } after the row schema's transforms; `note` is forwarded
  // raw (the service stores `note || null`), so the cast documents the shape
  // a well-formed body sends rather than a check that ran.
  const created = await splitService.createSplitsBatchAtomic({
    transaction_id,
    splits: preparedSplits,
    actor: resolveActor(req),
  } as Parameters<typeof splitService.createSplitsBatchAtomic>[0]);
  res.status(201);
  res.ok({ items: created, total: created.length });
});

// POST /api/splits/bulk — the transactions page's bulk "Split" action.
// Rate-limited like the transactions bulk routes (30/min).
router.post(
  "/bulk",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "splits-bulk",
  }),
  async (req, res) => {
    const { transaction_ids, recipient_id, mode, note } = parseSplitsBody(
      bulkSplitSchema,
      req.body,
    );
    const result = await splitService.createBulkSplitsAtomic({
      transaction_ids,
      recipient_id,
      mode,
      note,
      actor: resolveActor(req),
    });
    res.status(201);
    res.ok(result);
  },
);

router.post("/:id/pay", validateIdParam, async (req, res) => {
  const splitId = parseRouteId(req);
  // payBodySchema is `z.looseObject({})` — amount is validated by superRefine
  // but zod's inferred type is still `unknown` (raw values forwarded
  // unchanged, see module doc). Cast documents what's actually been checked.
  const { amount, note, paid_at } = parseSplitsBody(
    payBodySchema,
    req.body,
  ) as PayBody;
  // Service serializes existence + overpayment check + insert under
  // SELECT … FOR UPDATE; routes no longer precheck (race window).
  const payment = await splitService.addPayment({
    split_id: splitId,
    amount,
    note,
    paid_at,
    actor: resolveActor(req),
  });
  res.status(201);
  res.ok(payment);
});

router.get("/:id/payments", validateIdParam, async (req, res) => {
  const splitId = parseRouteId(req);
  const page = parseOptionalPagination(req.query, { maxLimit: 1000 });
  const payments = await splitService.getPayments(splitId, page ?? {});
  const total = page
    ? await splitService.countPayments(splitId)
    : payments.length;
  res.ok(listBody(payments, total, page));
});

router.post("/:id/settle", validateIdParam, async (req, res) => {
  const splitId = parseRouteId(req);
  const split = await splitService.settleSplit(splitId, resolveActor(req));
  if (!split) throw new NotFoundError("Split not found");
  res.ok(split);
});

router.post("/owed/:id/settle-all", validateIdParam, async (req, res) => {
  const recipientId = parseRouteId(req);
  const result = await splitService.settleAllByRecipient(
    recipientId,
    resolveActor(req),
  );
  res.ok(result);
});

router.delete("/:id", validateIdParam, async (req, res) => {
  const splitId = parseRouteId(req);
  const deleted = await splitService.deleteSplit(splitId, resolveActor(req));
  if (!deleted) throw new NotFoundError("Split not found");
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

export default router;
