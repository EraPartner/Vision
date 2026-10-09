/**
 * Recipient routes.
 */

import { Router } from "express";
import { z } from "zod";
import recipientService from "../services/recipientService.ts";
import { mergeRecipients as mergeRecipientsAtomic } from "../services/recipientMergeService.ts";
import {
  listPatternsForRecipient,
  createPattern,
  updatePattern,
  deletePattern,
  previewPatternMatches,
  suggestPatternFromNames,
} from "../services/recipientPatternService.ts";
import { findRecipientClusters } from "../services/recipientClusterService.ts";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.ts";
import { parsePagination } from "../lib/pagination.ts";
import { withCreateOutcome } from "../lib/createOutcome.ts";
import { nullAsAbsent, parseInput } from "../lib/zodInput.ts";
import {
  booleanQuery,
  idParams,
  idSchema,
  nullableId,
  optionalIdFilter,
  pageFields,
  requiredString,
  singleQueryString,
} from "./_requestSchemas.ts";
// The MVs attribute transactions to categories via a 3-level resolution
// (COALESCE(t.category_id, r.default_category_id, pr.default_category_id),
// where pr is the recipient's PRIMARY recipient), so recipient edits/merges/
// deletes must schedule a refresh — otherwise the dashboard serves the old
// grouping until an unrelated transaction mutation.
import { scheduleRefresh } from "../services/materializedViewService.ts";

const router = Router();

// ── Request schemas ──────────────────────────────────────────────────────────

const patternParams = z.object({ id: idSchema(), patternId: idSchema() });

const clustersQuery = z.object({
  min_count: singleQueryString.transform((raw) =>
    Math.max(2, parseInt(raw ?? "", 10) || 2),
  ),
});

const listQuery = z
  .object({
    ...pageFields,
    name: singleQueryString,
    search: singleQueryString,
    sort_by: singleQueryString,
    // Anything but asc/desc falls back to the repository's default order.
    sort_dir: z.enum(["asc", "desc"]).optional().catch(undefined),
    // Same strict id parse as every other id query param: absent/empty is "no
    // filter" (undefined, 200), malformed is a 400. `parseInt` truncated
    // instead — ?default_category_id=12abc listed the recipients defaulting to
    // category 12 — and a NaN reached Postgres as a 22P02 500.
    default_category_id: optionalIdFilter,
    active: booleanQuery(true),
    uncategorized: booleanQuery(false),
  })
  .transform((query) => ({
    ...parsePagination(query, { maxLimit: 1000 }),
    name: query.name || undefined,
    defaultCategoryId: query.default_category_id,
    search: query.search ? query.search.slice(0, 200) : undefined,
    active: query.active,
    uncategorized: query.uncategorized,
    sortBy: query.sort_by || undefined,
    sortDir: query.sort_dir,
  }));

const optionalText = z.string().nullable().optional();

const createBody = z.object({
  name: requiredString,
  default_category_id: nullableId,
  notes: optionalText,
});

// null name / is_active mean "leave unchanged" in recipientRepository.update.
const updateBody = z.object({
  name: optionalText,
  default_category_id: nullableId,
  notes: optionalText,
  is_active: z.boolean().nullable().optional(),
});

const mergeBody = z.object({
  alias_ids: z
    .array(idSchema(), {
      error: "Missing required field: alias_ids (array of recipient IDs)",
    })
    .min(1, "Missing required field: alias_ids (array of recipient IDs)"),
});

const patternKind = z.enum(["literal_prefix", "glob", "regex"]);

// recipient_match_patterns.priority is INTEGER.
const patternFields = {
  pattern_kind: patternKind.optional(),
  case_sensitive: z.boolean().optional(),
  priority: z.int32().optional(),
  // null clears the note on PATCH (and stores none on create).
  notes: z.string().nullable().optional(),
};

// On create and preview, null means "use the default" (createPattern's `??`);
// on PATCH these columns are NOT NULL, so null stays a 400.
const createPatternBody = z.object({
  pattern: requiredString,
  ...patternFields,
  pattern_kind: nullAsAbsent(patternKind),
  case_sensitive: nullAsAbsent(z.boolean()),
  priority: nullAsAbsent(z.int32()),
});

const previewPatternBody = z.object({
  pattern: requiredString,
  pattern_kind: nullAsAbsent(patternKind),
  case_sensitive: nullAsAbsent(z.boolean()),
});

const updatePatternBody = z.object({
  pattern: z.string().optional(),
  ...patternFields,
  is_active: z.boolean().optional(),
});

// ── Routes ───────────────────────────────────────────────────────────────────

router.get("/clusters", async (req, res) => {
  const { min_count: minCount } = parseInput(clustersQuery, req.query);
  const clusters = await findRecipientClusters({ minCount });
  res.ok({ items: clusters, total: clusters.length });
});

router.get("/", async (req, res) => {
  const opts = parseInput(listQuery, req.query);

  const [items, total] = await Promise.all([
    recipientService.getAll(opts),
    recipientService.getCount(opts),
  ]);

  res.ok({
    items: items.map((r) => ({
      ...r,
      links: [],
    })),
    total,
    limit: opts.limit,
    offset: opts.offset,
    links: [],
  });
});

router.post("/", async (req, res) => {
  const { name, default_category_id, notes } = parseInput(createBody, req.body);

  const { recipient, created } = await recipientService.createOrGet({ name });
  // Only null if the row vanished between upsert and re-read.
  if (!recipient) throw new NotFoundError("Recipient not found");

  let finalRecipient: typeof recipient | null = recipient;
  if (default_category_id != null || notes != null) {
    finalRecipient = await recipientService.update(recipient.id, {
      default_category_id,
      notes,
    });
  }

  res.status(created ? 201 : 200);
  res.ok(withCreateOutcome(finalRecipient ?? {}, created));
});

router.get("/:id", async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  const recipient = await recipientService.getById(id);
  if (!recipient) throw new NotFoundError("Recipient not found");
  res.ok({ ...recipient, links: [] });
});

router.patch("/:id", async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  const updated = await recipientService.update(
    id,
    parseInput(updateBody, req.body),
  );
  if (!updated) throw new NotFoundError("Recipient not found");
  scheduleRefresh();
  res.ok({ ...updated, links: [] });
});

router.delete("/:id", async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  const deleted = await recipientService.hardDelete(id);
  if (!deleted) throw new NotFoundError("Recipient not found");
  scheduleRefresh();
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

router.post("/:id/merge", async (req, res) => {
  const { id: primaryId } = parseInput(idParams, req.params);
  const { alias_ids: aliasIds } = parseInput(mergeBody, req.body);

  const primary = await recipientService.getById(primaryId);
  if (!primary) throw new NotFoundError("Primary recipient not found");
  if (primary.primary_recipient_id) {
    throw new ValidationError(
      "Cannot merge into a recipient that is itself an alias. Use its primary instead.",
    );
  }

  const { mergedAliasIds, reassigned } = await mergeRecipientsAtomic(
    primaryId,
    aliasIds,
  );
  const updatedPrimary = await recipientService.getById(primaryId);
  if (!updatedPrimary) throw new NotFoundError("Primary recipient not found");
  const aliases = await recipientService.getAliases(primaryId);

  // Build pattern suggestion from merged alias names + primary name
  const mergedNames = aliases
    .filter((a) => mergedAliasIds.includes(a.id))
    .map((a) => a.name);
  const allNames = [updatedPrimary.name, ...mergedNames];
  const suggestion = suggestPatternFromNames(allNames);

  let patternSuggestion = null;
  if (suggestion) {
    try {
      const preview = await previewPatternMatches({
        pattern: suggestion.pattern,
        pattern_kind: suggestion.kind,
        case_sensitive: false,
      });
      patternSuggestion = {
        pattern: suggestion.pattern,
        kind: suggestion.kind,
        matchCount: preview.matchCount,
        confidence: suggestion.confidence,
      };
    } catch {
      // suggestion is optional; ignore preview errors
    }
  }

  scheduleRefresh();
  res.ok({
    primary: { ...updatedPrimary, links: [] },
    merged_ids: mergedAliasIds,
    reassigned,
    aliases: aliases.map((a) => ({ id: a.id, name: a.name })),
    patternSuggestion,
  });
});

router.post("/:id/unmerge", async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  const success = await recipientService.unmergeRecipient(id);
  if (!success) throw new NotFoundError("Recipient not found");
  const recipient = await recipientService.getById(id);
  scheduleRefresh();
  res.ok({ ...recipient, links: [] });
});

router.get("/:id/aliases", async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  const aliases = await recipientService.getAliases(id);
  res.ok({
    items: aliases.map((a) => ({
      ...a,
      links: [],
    })),
    total: aliases.length,
  });
});

// ── Pattern sub-routes ───────────────────────────────────────────────────────

router.get("/:id/patterns", async (req, res) => {
  const { id } = parseInput(idParams, req.params);
  const patterns = await listPatternsForRecipient(id);
  res.ok({ items: patterns, total: patterns.length });
});

router.post("/:id/patterns", async (req, res) => {
  const { id: recipientId } = parseInput(idParams, req.params);
  const { pattern, pattern_kind, case_sensitive, priority, notes } = parseInput(
    createPatternBody,
    req.body,
  );
  const result = await createPattern({
    recipientId,
    pattern,
    pattern_kind,
    case_sensitive,
    priority,
    notes,
  });
  res.status(201);
  res.ok(result);
});

router.post("/:id/patterns/preview", async (req, res) => {
  parseInput(idParams, req.params);
  const { pattern, pattern_kind, case_sensitive } = parseInput(
    previewPatternBody,
    req.body,
  );
  const result = await previewPatternMatches({
    pattern,
    pattern_kind: pattern_kind ?? "literal_prefix",
    case_sensitive: case_sensitive ?? false,
  });
  res.ok(result);
});

router.patch("/:id/patterns/:patternId", async (req, res) => {
  const { patternId } = parseInput(patternParams, req.params);
  await updatePattern(patternId, parseInput(updatePatternBody, req.body));
  res.ok({ patternId });
});

router.delete("/:id/patterns/:patternId", async (req, res) => {
  const { patternId } = parseInput(patternParams, req.params);
  await deletePattern(patternId);
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

export default router;
