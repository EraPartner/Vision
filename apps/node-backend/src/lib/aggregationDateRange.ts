import { assertYmd } from "./validation.ts";
import { ValidationError } from "../middleware/errorHandler.ts";

/**
 * Parse the canonical `start_date`/`end_date` aggregation range. Retired
 * aliases are rejected so a stale client cannot silently widen its query.
 */
export function parseAggregationDateRange(query: Record<string, unknown>): {
  startDate: string | undefined;
  endDate: string | undefined;
} {
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
