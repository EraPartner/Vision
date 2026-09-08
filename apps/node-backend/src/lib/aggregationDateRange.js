import { assertYmd } from "./validation.js";
import { ValidationError } from "../middleware/errorHandler.js";

/**
 * Normalize the aggregations API's legacy `start`/`end` aliases onto the
 * canonical `start_date`/`end_date` contract. Canonical keys win when both are
 * present, including when the canonical value is empty (no bound).
 *
 * @param {Record<string, unknown>} query
 * @returns {{ startDate: string|undefined, endDate: string|undefined }}
 */
export function parseAggregationDateRange(query) {
  const start = query.start_date !== undefined ? query.start_date : query.start;
  const end = query.end_date !== undefined ? query.end_date : query.end;
  const startDate = assertYmd(start, "start_date");
  const endDate = assertYmd(end, "end_date");

  if (startDate && endDate && startDate > endDate) {
    throw new ValidationError("start_date must not be after end_date");
  }

  return { startDate, endDate };
}
