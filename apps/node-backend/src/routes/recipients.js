/**
 * Recipient routes.
 */

import { Router } from 'express';
import recipientRepository from '../services/recipientService.js';
import { mergeRecipients as mergeRecipientsAtomic } from '../services/recipientMergeService.js';
import {
  listPatternsForRecipient,
  createPattern,
  updatePattern,
  deletePattern,
  previewPatternMatches,
  suggestPatternFromNames,
} from '../services/recipientPatternService.js';
import { findRecipientClusters } from '../services/recipientClusterService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam } from '../middleware/validation.js';
import { parsePagination } from '../lib/pagination.js';
// The MVs attribute transactions to categories via the recipient's
// default_category_id (COALESCE(t.category_id, r.default_category_id)), so
// recipient edits/merges/deletes must schedule a refresh — otherwise the
// dashboard serves the old grouping until an unrelated transaction mutation.
import { scheduleRefresh } from '../services/materializedViewService.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

router.get('/clusters', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const minCount = Math.max(2, parseInt(req.query.min_count, 10) || 2);
  const clusters = await findRecipientClusters({ minCount });
  res.ok({ items: clusters, total: clusters.length });
});

router.get('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const {
    name, default_category_id,
    active = 'true', search, uncategorized = 'false', sort_by, sort_dir,
  } = req.query;

  const { limit, offset } = parsePagination(req.query, { maxLimit: 1000 });
  const opts = {
    limit,
    offset,
    name: name || null,
    defaultCategoryId: default_category_id ? parseInt(default_category_id, 10) : null,
    search: search ? String(search).slice(0, 200) : null,
    active: active !== 'false',
    uncategorized: uncategorized === 'true',
    sortBy: sort_by || null,
    sortDir: sort_dir === 'asc' || sort_dir === 'desc' ? sort_dir : null,
  };

  const [items, total] = await Promise.all([
    recipientRepository.getAll(opts),
    recipientRepository.getCount(opts),
  ]);

  res.ok({
    items: items.map((r) => ({
      ...r,
      /** @type {any[]} */
      links: [],
    })),
    total,
    limit: opts.limit,
    offset: opts.offset,
    links: [],
  });
});

router.post('/', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { name, default_category_id, notes } = req.body;
  if (!name) throw new ValidationError('Missing required field: name');

  const { recipient, created } = await recipientRepository.createOrGet({ name });

  let finalRecipient = recipient;
  if (default_category_id != null || notes != null) {
    finalRecipient = await recipientRepository.update(recipient.id, { default_category_id, notes });
  }

  res.status(created ? 201 : 200);
  res.ok({ ...finalRecipient, links: [] });
});

router.get('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const recipient = await recipientRepository.getById(parseInt(req.params.id, 10));
  if (!recipient) throw new NotFoundError('Recipient not found');
  res.ok({ ...recipient, links: [] });
});

router.patch('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = await recipientRepository.update(id, req.body);
  if (!updated) throw new NotFoundError('Recipient not found');
  scheduleRefresh();
  res.ok({ ...updated, links: [] });
});

router.delete('/:id', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = await recipientRepository.hardDelete(id);
  if (!deleted) throw new NotFoundError('Recipient not found');
  scheduleRefresh();
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

router.post('/:id/merge', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const primaryId = parseInt(req.params.id, 10);
  const { alias_ids } = req.body;
  if (!alias_ids || !Array.isArray(alias_ids) || alias_ids.length === 0) {
    throw new ValidationError('Missing required field: alias_ids (array of recipient IDs)');
  }

  const primary = await recipientRepository.getById(primaryId);
  if (!primary) throw new NotFoundError('Primary recipient not found');
  if (primary.primary_recipient_id) {
    throw new ValidationError('Cannot merge into a recipient that is itself an alias. Use its primary instead.');
  }

  const { mergedAliasIds, reassigned } = await mergeRecipientsAtomic(
    primaryId,
    alias_ids.map(Number),
  );
  const updatedPrimary = await recipientRepository.getById(primaryId);
  const aliases = await recipientRepository.getAliases(primaryId);

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
      patternSuggestion = { pattern: suggestion.pattern, kind: suggestion.kind, matchCount: preview.matchCount, confidence: suggestion.confidence };
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

router.post('/:id/unmerge', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const success = await recipientRepository.unmergeRecipient(id);
  if (!success) throw new NotFoundError('Recipient not found');
  const recipient = await recipientRepository.getById(id);
  scheduleRefresh();
  res.ok({ ...recipient, links: [] });
});

router.get('/:id/aliases', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const aliases = await recipientRepository.getAliases(id);
  res.ok({
    items: aliases.map((a) => ({
      ...a,
      /** @type {any[]} */
      links: [],
    })),
    total: aliases.length,
  });
});

// ── Pattern sub-routes ───────────────────────────────────────────────────────

router.get('/:id/patterns', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const patterns = await listPatternsForRecipient(id);
  res.ok({ items: patterns, total: patterns.length });
});

router.post('/:id/patterns', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const recipientId = parseInt(req.params.id, 10);
  const { pattern, pattern_kind, case_sensitive, priority, notes } = req.body;
  if (!pattern) throw new ValidationError('Missing required field: pattern');
  const result = await createPattern({ recipientId, pattern, pattern_kind, case_sensitive, priority, notes });
  res.status(201);
  res.ok(result);
});

router.post('/:id/patterns/preview', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { pattern, pattern_kind, case_sensitive } = req.body;
  if (!pattern) throw new ValidationError('Missing required field: pattern');
  const result = await previewPatternMatches({ pattern, pattern_kind: pattern_kind ?? 'literal_prefix', case_sensitive: case_sensitive ?? false });
  res.ok(result);
});

router.patch('/:id/patterns/:patternId', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const patternId = parseInt(req.params.patternId, 10);
  if (!Number.isInteger(patternId) || patternId <= 0) throw new ValidationError('Invalid patternId');
  await updatePattern(patternId, req.body);
  res.ok({ patternId });
});

router.delete('/:id/patterns/:patternId', validateIdParam, /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const patternId = parseInt(req.params.patternId, 10);
  if (!Number.isInteger(patternId) || patternId <= 0) throw new ValidationError('Invalid patternId');
  await deletePattern(patternId);
  // Hard delete → 204 No Content (docs/reference/code-patterns.md, "DELETE responses").
  res.status(204).send();
});

export default router;
