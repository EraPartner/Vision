/**
 * Recipient routes.
 */

import { Router } from 'express';
import recipientRepository from '../repositories/recipientRepository.js';
import { mergeRecipients as mergeRecipientsAtomic } from '../services/recipientMergeService.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';
import { validateIdParam } from '../middleware/validation.js';

const router = Router();

router.get('/', async (req, res) => {
  const {
    limit = 50, offset = 0, name, default_category_id,
    active = 'true', search, uncategorized = 'false', sort_by, sort_dir,
  } = req.query;

  const opts = {
    limit: Math.min(parseInt(limit, 10) || 50, 1000),
    offset: parseInt(offset, 10) || 0,
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
    items: items.map((r) => ({ ...r, links: [] })),
    total,
    limit: opts.limit,
    offset: opts.offset,
    links: [],
  });
});

router.post('/', async (req, res) => {
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

router.get('/:id', validateIdParam, async (req, res) => {
  const recipient = await recipientRepository.getById(parseInt(req.params.id, 10));
  if (!recipient) throw new NotFoundError('Recipient not found');
  res.ok({ ...recipient, links: [] });
});

router.patch('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const updated = await recipientRepository.update(id, req.body);
  if (!updated) throw new NotFoundError('Recipient not found');
  res.ok({ ...updated, links: [] });
});

router.delete('/:id', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = await recipientRepository.hardDelete(id);
  if (!deleted) throw new NotFoundError('Recipient not found');
  res.ok({ message: `Recipient ${id} deleted permanently`, links: [] });
});

router.post('/:id/merge', validateIdParam, async (req, res) => {
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

  res.ok({
    primary: { ...updatedPrimary, links: [] },
    merged_ids: mergedAliasIds,
    reassigned,
    aliases: aliases.map((a) => ({ id: a.id, name: a.name })),
  });
});

router.post('/:id/unmerge', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const success = await recipientRepository.unmergeRecipient(id);
  if (!success) throw new NotFoundError('Recipient not found');
  const recipient = await recipientRepository.getById(id);
  res.ok({ ...recipient, links: [] });
});

router.get('/:id/aliases', validateIdParam, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const aliases = await recipientRepository.getAliases(id);
  res.ok({
    items: aliases.map((a) => ({ ...a, links: [] })),
    total: aliases.length,
  });
});

export default router;
