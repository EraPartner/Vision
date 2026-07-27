/**
 * Shared helpers for the saved-parser-config CRUD routes (transaction + portfolio
 * import). Both routers persist into the same custom_parser_configs table, so the
 * id parsing, name normalisation, and the (name, kind)-unique constraint name are
 * identical — kept here so the two routers cannot drift.
 */

import { ValidationError, NotFoundError, ConflictError } from '../middleware/errorHandler.js';
import customParserConfigRepository from '../services/customParserConfigService.js';

// (name, kind)-unique since migration 0041; both budgeting and portfolio parsers share it.
export const PARSER_NAME_CONSTRAINT = 'uq_custom_parser_configs_name_kind';

export function parseParserId(req) {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) throw new ValidationError('Invalid parser config id');
  return id;
}

export function normalizeParserName(name) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('Missing or invalid "name"');
  }
  return name.trim();
}

/**
 * Register the four saved-parser-config CRUD handlers (GET/POST/PATCH/DELETE
 * /parsers[/:id]) on a router. The transaction and portfolio import routers are
 * identical here apart from the parser `kind`, the config normaliser, and the
 * word in the conflict message — parameterised so the two cannot drift (SIMP-30).
 *
 * @param {import('express').Router} router
 * @param {{ kind: string, normalizeConfig: (config: unknown) => object, label?: string }} opts
 *   `label` is inserted into the 23505 conflict message ("A <label>parser named …").
 */
export function registerParserRoutes(router, { kind, normalizeConfig, label = '' }) {
  const conflictMessage = (name) => `A ${label}parser named "${name}" already exists`;

  // Canonical collection shape `{items, total}`. Unpaginated, so `total` is
  // just the row count — it exists so pagination can be added without a
  // breaking response-shape change.
  router.get('/parsers', async (req, res) => {
    const items = await customParserConfigRepository.getAll(kind);
    res.ok({ items, total: items.length });
  });

  router.post('/parsers', async (req, res) => {
    const name = normalizeParserName(req.body.name);
    const config = normalizeConfig(req.body.config);
    try {
      const created = await customParserConfigRepository.create({ name, config, kind });
      res.status(201);
      res.ok(created);
    } catch (err) {
      if (err.code === '23505' && err.constraint === PARSER_NAME_CONSTRAINT) {
        throw new ConflictError(conflictMessage(name));
      }
      throw err;
    }
  });

  router.patch('/parsers/:id', async (req, res) => {
    const id = parseParserId(req);
    const name = req.body.name !== undefined ? normalizeParserName(req.body.name) : undefined;
    const config = req.body.config !== undefined ? normalizeConfig(req.body.config) : undefined;
    try {
      const updated = await customParserConfigRepository.update(id, { name, config });
      if (!updated) throw new NotFoundError('Parser config not found');
      res.ok(updated);
    } catch (err) {
      if (err.code === '23505' && err.constraint === PARSER_NAME_CONSTRAINT) {
        throw new ConflictError(conflictMessage(name));
      }
      throw err;
    }
  });

  router.delete('/parsers/:id', async (req, res) => {
    const id = parseParserId(req);
    const deleted = await customParserConfigRepository.delete(id);
    if (!deleted) throw new NotFoundError('Parser config not found');
    res.status(204).send();
  });
}
