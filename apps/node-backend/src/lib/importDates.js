import { epochMsToUtcYmd } from "./dateFormat.js";

/**
 * Coerce an adapter-parsed date to a 'YYYY-MM-DD' string for the import staging
 * tables and dedup hashes. The input is either a JS Date built by an adapter
 * from the CSV value (UTC-constructed, so UTC extraction is correct) or an
 * already-normalised 'YYYY-MM-DD…' string. Returns undefined for anything else
 * (callers writing a DB param coalesce to null at the boundary).
 *
 * NOTE: only for *parsed* dates. A value read back from a Postgres DATE column
 * arrives as a server-local-midnight Date and must be formatted with local
 * getters instead (see importPipeline/commit.js) — toISOString() there would
 * roll back a day for timezones east of UTC. Do not use this helper for that.
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function parsedDateToYmd(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? undefined
      : epochMsToUtcYmd(value.getTime());
  }
  if (typeof value === "string") return value.slice(0, 10);
  return undefined;
}
