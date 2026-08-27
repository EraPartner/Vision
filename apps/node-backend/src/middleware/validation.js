/**
 * Express parameter-validation middleware.
 *
 * Pure validators live in lib/validation.js. They are re-exported here so the
 * route layer keeps its established import path while lower layers depend on
 * the canonical library module directly.
 */

import { validateId } from '../lib/validation.js';
import { ValidationError } from './errorHandler.js';

export * from '../lib/validation.js';

/**
 * Validate a route parameter again at its point of use and return its numeric
 * value, so handler safety does not depend on middleware ordering.
 * @param {import('../types/express.js').ExpressRequest} req
 * @param {string} [name]
 * @returns {number}
 */
export function assertIdParam(req, name = 'id') {
  const result = validateId(req.params[name], name);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

/**
 * @param {import('../types/express.js').ExpressRequest} req
 * @param {import('../types/express.js').ExpressResponse} _res
 * @param {import('../types/express.js').ExpressNextFunction} next
 */
export function validateIdParam(req, _res, next) {
  if (req.params.id) {
    const result = validateId(req.params.id);
    if (!result.valid) return next(new ValidationError(result.error));
    req.params.id = /** @type {string} */ (/** @type {unknown} */ (result.value));
  }
  next();
}

/**
 * @param {string} name
 * @returns {(req: import('../types/express.js').ExpressRequest, res: import('../types/express.js').ExpressResponse, next: import('../types/express.js').ExpressNextFunction) => void}
 */
export function validateIntParam(name) {
  return (req, _res, next) => {
    const result = validateId(req.params[name], name);
    if (!result.valid) return next(new ValidationError(result.error));
    req.params[name] = /** @type {string} */ (/** @type {unknown} */ (result.value));
    next();
  };
}
