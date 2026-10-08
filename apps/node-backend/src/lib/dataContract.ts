/**
 * Data-contract checks for data Vision itself produced: bank/portfolio adapter
 * output, saved parser configs read back from `custom_parser_configs`, and
 * (through database/rowContracts.ts) PostgreSQL rows (ADR-193).
 *
 * A mismatch here is a bug in Vision, not bad user input, so it never becomes
 * a 400. Tests and development throw so the bug fails loudly; every other
 * environment follows {@link PRODUCTION_DATA_CONTRACT_MODE}, the one switch. Logs carry issue
 * paths and codes only: the checked values are personal financial data.
 */
import type { z } from "zod";
import { logger } from "../config/logger.ts";

export type DataContractMode = "throw" | "log";

/**
 * Production behaviour on a mismatch, pending the owner's decision:
 * `"log"` warns and passes the data through, `"throw"` blocks it.
 */
export const PRODUCTION_DATA_CONTRACT_MODE: DataContractMode = "log";

/**
 * Tests and development are strict; every other environment uses
 * {@link PRODUCTION_DATA_CONTRACT_MODE}. Reads the environment as config.ts
 * and the logger do (unset counts as development; any Vitest run is a test
 * run) without importing config.ts, which adapter tests load under fs mocks.
 */
export function dataContractMode(
  environment: string = process.env.VITEST
    ? "test"
    : process.env.ENVIRONMENT || process.env.NODE_ENV || "development",
): DataContractMode {
  const env = environment.toLowerCase();
  return env === "test" || env === "development"
    ? "throw"
    : PRODUCTION_DATA_CONTRACT_MODE;
}

const MAX_REPORTED_ISSUES = 10;

/** Issue locations without values, e.g. `12.amount (invalid_type)`. */
function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".") || "(root)";
    return `${path} (${issue.code})`;
  });
}

/**
 * Checks `value` against `schema` and returns whether it matched. The value
 * itself is never transformed, so callers keep passing the original through.
 *
 * @param context names the contract in the error/log, e.g. `bank adapter "kbc" output`
 * @param mode defaults to {@link dataContractMode}
 */
export function checkDataContract(
  schema: z.ZodType,
  value: unknown,
  context: string,
  mode: DataContractMode = dataContractMode(),
): boolean {
  const result = schema.safeParse(value);
  if (result.success) return true;

  const issues = describeIssues(result.error);
  const reported = issues.slice(0, MAX_REPORTED_ISSUES);
  if (mode === "throw") {
    const more =
      issues.length > reported.length
        ? ` (+${issues.length - reported.length} more)`
        : "";
    throw new Error(
      `Data contract violated: ${context} at ${reported.join(", ")}${more}`,
    );
  }
  logger.warn(`[data-contract] ${context} does not match its schema`, {
    issues: reported,
    issueCount: issues.length,
  });
  return false;
}
