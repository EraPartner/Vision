/**
 * Shared helpers for the saved-parser-config CRUD routes (transaction + portfolio
 * import). Both routers persist into the same custom_parser_configs table, so the
 * id parsing, name normalisation, and the (name, kind)-unique constraint name are
 * identical — kept here so the two routers cannot drift.
 */

import { ValidationError, NotFoundError, ConflictError } from '../middleware/errorHandler.js';
import { validateId, validateIdParam } from '../middleware/validation.js';
import customParserConfigRepository from '../services/customParserConfigService.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 * @typedef {import('../types/express.js').ExpressRouter} ExpressRouter
 */

// (name, kind)-unique since migration 0041; both budgeting and portfolio parsers share it.
export const PARSER_NAME_CONSTRAINT = 'uq_custom_parser_configs_name_kind';

/**
 * Parse `:id` for the PATCH/DELETE parser-config handlers.
 *
 * Delegates to `validateId` so the accept set is the one every other `:id`
 * param uses: a plain base-10 digit string or an integer number, 1..2^31-1.
 * The routes also carry `validateIdParam`, which re-stamps `req.params.id`
 * with the parsed number — hence the number branch in `validateId` — so this
 * is the second of two identical checks and cannot disagree with the first.
 *
 * It was `parseInt` guarded only by `Number.isNaN`, which takes the leading
 * digits of anything: `DELETE /parsers/12abc` returned **204 having deleted
 * parser 12**, `12.5` hit 12 and `1e3` hit 1 — an irreversible delete of a
 * record the caller never named, reported as success. `-1` and `0` cleared the
 * NaN check too and reached the repository as-is.
 * @param {ExpressRequest} req
 * @returns {number}
 */
export function parseParserId(req) {
  const result = validateId(req.params.id, 'parser config id');
  if (!result.valid) throw new ValidationError('Invalid parser config id');
  return result.value;
}

/**
 * @param {unknown} name
 * @returns {string}
 */
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
 * @param {ExpressRouter} router
 * @param {{ kind: string, normalizeConfig: (config: unknown) => object, label?: string }} opts
 *   `label` is inserted into the 23505 conflict message ("A <label>parser named …").
 */
export function registerParserRoutes(router, { kind, normalizeConfig, label = '' }) {
  /** @param {string} name */
  const conflictMessage = (name) => `A ${label}parser named "${name}" already exists`;

  // Canonical collection shape `{items, total}`. Unpaginated, so `total` is
  // just the row count — it exists so pagination can be added without a
  // breaking response-shape change.
  router.get('/parsers', async (/** @type {ExpressRequest} */ req, /** @type {ExpressResponse} */ res) => {
    const items = await customParserConfigRepository.getAll(kind);
    res.ok({ items, total: items.length });
  });

  router.post('/parsers', async (/** @type {ExpressRequest} */ req, /** @type {ExpressResponse} */ res) => {
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

  // validateIdParam on both id-bearing operations, as every other `:id` route
  // in the app has: the guard belongs at the router edge, not only inside the
  // handler, so a malformed id never reaches a repository call.
  router.patch('/parsers/:id', validateIdParam, async (/** @type {ExpressRequest} */ req, /** @type {ExpressResponse} */ res) => {
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

  router.delete('/parsers/:id', validateIdParam, async (/** @type {ExpressRequest} */ req, /** @type {ExpressResponse} */ res) => {
    const id = parseParserId(req);
    const deleted = await customParserConfigRepository.delete(id);
    if (!deleted) throw new NotFoundError('Parser config not found');
    res.status(204).send();
  });
}
