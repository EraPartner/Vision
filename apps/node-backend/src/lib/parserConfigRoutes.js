/**
 * Shared helpers for the saved-parser-config CRUD routes (transaction + portfolio
 * import). Both routers persist into the same custom_parser_configs table, so the
 * id parsing, name normalisation, and the (name, kind)-unique constraint name are
 * identical — kept here so the two routers cannot drift.
 */

import { ValidationError } from '../middleware/errorHandler.js';

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
