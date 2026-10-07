/**
 * Express parameter-validation middleware.
 *
 * Pure validators live in lib/validation.ts. They are re-exported here so the
 * route layer keeps its established import path while lower layers depend on
 * the canonical library module directly.
 */

import { validateId } from "../lib/validation.ts";
import { ValidationError } from "./errorHandler.ts";
import type {
  ExpressNextFunction,
  ExpressRequest,
  ExpressResponse,
} from "../types/express.ts";

export * from "../lib/validation.ts";

/**
 * Validate a route parameter again at its point of use and return its numeric
 * value, so handler safety does not depend on middleware ordering.
 */
export function assertIdParam(req: ExpressRequest, name = "id"): number {
  const result = validateId(req.params[name], name);
  if (!result.valid) throw new ValidationError(result.error);
  return result.value;
}

export function validateIdParam(
  req: ExpressRequest,
  _res: ExpressResponse,
  next: ExpressNextFunction,
) {
  if (req.params.id) {
    const result = validateId(req.params.id);
    if (!result.valid) return next(new ValidationError(result.error));
  }
  next();
}

export function validateIntParam(
  name: string,
): (
  req: ExpressRequest,
  res: ExpressResponse,
  next: ExpressNextFunction,
) => void {
  return (req, _res, next) => {
    const result = validateId(req.params[name], name);
    if (!result.valid) return next(new ValidationError(result.error));
    next();
  };
}
