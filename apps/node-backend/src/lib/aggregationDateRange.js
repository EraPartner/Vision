import { assertYmd } from "./validation.js";
import { ValidationError } from "../middleware/errorHandler.js";

/**
 * Parse the canonical `start_date`/`end_date` aggregation range. Retired
 * aliases are rejected so a stale client cannot silently widen its query.
 *
 * @param {Record<string, unknown>} query
 * @returns {{ startDate: string|undefined, endDate: string|undefined }}
 */
export function parseAggregationDateRange(query) {
  if (query.start !== undefined || query.end !== undefined) {
    throw new ValidationError(
      'Use "start_date" and "end_date"; "start" and "end" are no longer supported',
    );
  }
  const startDate = assertYmd(query.start_date, "start_date");
  const endDate = assertYmd(query.end_date, "end_date");

  if (startDate && endDate && startDate > endDate) {
    throw new ValidationError("start_date must not be after end_date");
  }

  return { startDate, endDate };
}
