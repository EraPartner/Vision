/**
 * Tag Service — business logic + orchestration for tags.
 *
 * Sits between the routes and tagRepository so route files never reach into the
 * data-access layer directly (enforced by vision-local/no-repo-direct-from-route).
 */

import tagRepository from '../repositories/tagRepository.js';
import { slugify } from '../lib/slugify.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

export const tagService = {
  /**
   * List tags, optionally filtered by active status, with pagination.
   * @param {{ active?: boolean|null, limit?: number, offset?: number }} [opts]
   */
  async list({ active = null, limit, offset } = {}) {
    const [items, total] = await Promise.all([
      tagRepository.getAll({ active, limit, offset }),
      tagRepository.getCount({ active }),
    ]);
    return { items, total };
  },

  /**
   * Create a tag by slug, or reactivate a soft-deleted one. Returns the tag plus
   * the metadata the route needs to pick a status code and surface reactivation.
   *
   * @param {{ slug?: string, color?: string | null }} [args]
   */
  async createOrReactivate({ slug: rawSlug, color = null } = {}) {
    if (!rawSlug) throw new ValidationError('Missing required field: slug');

    const slug = slugify(rawSlug);
    if (!slug) throw new ValidationError('slug is empty after normalization');

    if (color !== null && color !== undefined && typeof color !== 'string') {
      throw new ValidationError('color must be a string');
    }

    const preexisting = await tagRepository.getBySlug(slug);
    const wasInactive = Boolean(preexisting && !preexisting.is_active);
    let junctionCount = 0;
    if (wasInactive) {
      junctionCount = await tagRepository.countTransactionReferences(preexisting.id);
    }

    const { tag, reactivated } = await tagRepository.findOrCreateBySlug(slug, color ?? null);
    return { tag, reactivated, wasInactive, junctionCount };
  },

  /**
   * Update a tag's color and/or active status.
   *
   * @param {number | string} id
   * @param {{ color?: string | null, is_active?: boolean | null }} [updates]
   */
  async update(id, { color, is_active } = {}) {
    if (color !== undefined && color !== null && typeof color !== 'string') {
      throw new ValidationError('color must be a string or null');
    }
    if (is_active !== undefined && is_active !== null && typeof is_active !== 'boolean') {
      throw new ValidationError('is_active must be a boolean');
    }

    const updated = await tagRepository.update(id, { color, is_active });
    if (!updated) throw new NotFoundError(`Tag ${id} not found`);
    return updated;
  },

  /** Soft-delete (deactivate) a tag. */
  async softDelete(id) {
    const deleted = await tagRepository.softDelete(id);
    if (!deleted) throw new NotFoundError(`Tag ${id} not found`);
    return deleted;
  },
};

export default tagService;
