/**
 * Recipient routes.
 *
 * Mirrors: apps/backend/api/api_routes_recipients.py
 */

import { Router } from 'express';
import recipientRepository from '../repositories/recipientRepository.js';
import { logger } from '../config/logger.js';
import { validateIdParam, sanitizeString } from '../middleware/validation.js';

const router = Router();

// GET /api/recipients
router.get('/', async (req, res) => {
  try {
    const { limit = 50, offset = 0, name, default_category_id, active = 'true', search, uncategorized = 'false' } = req.query;

    const opts = {
      limit: Math.min(parseInt(limit, 10) || 50, 1000),
      offset: parseInt(offset, 10) || 0,
      name: name || null,
      defaultCategoryId: default_category_id ? parseInt(default_category_id, 10) : null,
      search: search ? String(search).slice(0, 200) : null,
      active: active !== 'false',
      uncategorized: uncategorized === 'true',
    };

    const items = await recipientRepository.getAll(opts);
    const total = await recipientRepository.getCount(opts);

    res.json({
      items: items.map(r => ({ ...r, links: [] })),
      total,
      limit: opts.limit,
      offset: opts.offset,
      links: [],
    });
  } catch (err) {
    logger.error('Error retrieving recipients', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving recipients' });
  }
});

// POST /api/recipients (create or get)
router.post('/', async (req, res) => {
  try {
    const { name, default_category_id, notes } = req.body;
    if (!name) {
      return res.status(400).json({ detail: 'Missing required field: name' });
    }

    const { recipient, created } = await recipientRepository.createOrGet({ name });

    // Update additional fields if provided
    let finalRecipient = recipient;
    if (default_category_id != null || notes != null) {
      finalRecipient = await recipientRepository.update(recipient.id, { default_category_id, notes });
    }

    res.status(created ? 201 : 200).json({ ...finalRecipient, links: [] });
  } catch (err) {
    logger.error('Error creating recipient', { error: err.message });
    res.status(500).json({ detail: 'Error creating recipient' });
  }
});

// GET /api/recipients/:id
router.get('/:id', validateIdParam, async (req, res) => {
  try {
    const recipient = await recipientRepository.getById(parseInt(req.params.id, 10));
    if (!recipient) {
      return res.status(404).json({ detail: 'Recipient not found' });
    }
    res.json({ ...recipient, links: [] });
  } catch (err) {
    logger.error('Error retrieving recipient', { error: err.message });
    res.status(500).json({ detail: 'Error retrieving recipient' });
  }
});

// PATCH /api/recipients/:id
router.patch('/:id', validateIdParam, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const updated = await recipientRepository.update(id, req.body);
    if (!updated) {
      return res.status(404).json({ detail: 'Recipient not found' });
    }
    res.json({ ...updated, links: [] });
  } catch (err) {
    logger.error('Error updating recipient', { error: err.message });
    res.status(500).json({ detail: 'Error updating recipient' });
  }
});

// DELETE /api/recipients/:id
router.delete('/:id', validateIdParam, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const deleted = await recipientRepository.hardDelete(id);
    if (!deleted) {
      return res.status(404).json({ detail: 'Recipient not found' });
    }
    res.json({ message: `Recipient ${id} deleted permanently`, links: [] });
  } catch (err) {
    logger.error('Error deleting recipient', { error: err.message });
    res.status(500).json({ detail: 'Error deleting recipient' });
  }
});

// POST /api/recipients/:id/merge - Merge alias recipients into a primary
router.post('/:id/merge', validateIdParam, async (req, res) => {
  try {
    const primaryId = parseInt(req.params.id, 10);
    const { alias_ids } = req.body;
    if (!alias_ids || !Array.isArray(alias_ids) || alias_ids.length === 0) {
      return res.status(400).json({ detail: 'Missing required field: alias_ids (array of recipient IDs)' });
    }

    // Verify primary exists
    const primary = await recipientRepository.getById(primaryId);
    if (!primary) {
      return res.status(404).json({ detail: 'Primary recipient not found' });
    }

    // Cannot merge a recipient that is itself an alias
    if (primary.primary_recipient_id) {
      return res.status(400).json({ detail: 'Cannot merge into a recipient that is itself an alias. Use its primary instead.' });
    }

    const mergedIds = await recipientRepository.mergeRecipients(primaryId, alias_ids.map(Number));
    const updatedPrimary = await recipientRepository.getById(primaryId);
    const aliases = await recipientRepository.getAliases(primaryId);

    res.json({
      primary: { ...updatedPrimary, links: [] },
      merged_ids: mergedIds,
      aliases: aliases.map(a => ({ id: a.id, name: a.name })),
    });
  } catch (err) {
    logger.error('Error merging recipients', { error: err.message });
    res.status(500).json({ detail: 'Error merging recipients' });
  }
});

// POST /api/recipients/:id/unmerge - Remove a recipient from its primary group
router.post('/:id/unmerge', validateIdParam, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const success = await recipientRepository.unmergeRecipient(id);
    if (!success) {
      return res.status(404).json({ detail: 'Recipient not found' });
    }
    const recipient = await recipientRepository.getById(id);
    res.json({ ...recipient, links: [] });
  } catch (err) {
    logger.error('Error unmerging recipient', { error: err.message });
    res.status(500).json({ detail: 'Error unmerging recipient' });
  }
});

// GET /api/recipients/:id/aliases - Get all aliases for a primary recipient
router.get('/:id/aliases', validateIdParam, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const aliases = await recipientRepository.getAliases(id);
    res.json({ items: aliases.map(a => ({ ...a, links: [] })), total: aliases.length });
  } catch (err) {
    logger.error('Error getting aliases', { error: err.message });
    res.status(500).json({ detail: 'Error getting aliases' });
  }
});

export default router;
