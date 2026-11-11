#!/usr/bin/env bun
import { getTaxTable } from "../packages/shared-utils/src/belgianTax/constants.ts";
import {
  DEFAULT_COMMUNAL_SURCHARGE,
  EARLIEST_TAX_YEAR,
  LATEST_TAX_YEAR,
  SUPPORTED_TAX_YEARS,
} from "../packages/shared-utils/src/belgianTax/taxYears.ts";
import { isEntrypoint } from "./lib/isEntrypoint.ts";
import {
  generatedHeader,
  repoPath,
  writeGenerated,
} from "./lib/nativeCodegen.ts";

/**
 * Generates the Swift backend's Belgian tax tables from the TypeScript ones
 * (packages/shared-utils/src/belgianTax/constants.ts), so an indexed amount is typed once.
 * `BelgianTaxTable.swift` declares the fields; this writes one value per field and year.
 *
 *   bun run native:generate-tax-tables
 */

export const OUTPUT =
  "apps/native/Sources/VisionBackend/Tax/BelgianTaxTables.generated.swift";
const COMMAND = "native:generate-tax-tables";
const SOURCE =
  "scripts/native-tax-tables.ts from packages/shared-utils/src/belgianTax/constants.ts";

/** A Swift expression for a table value: a number, a list, or a memberwise `.init`. */
function literal(value: unknown): string {
  if (typeof value === "number") {
    if (value === Infinity) return ".infinity";
    if (!Number.isFinite(value))
      throw new Error(`No Swift literal for ${String(value)}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    const fields = Object.entries(value).map(
      ([key, field]) => `${key}: ${literal(field)}`,
    );
    return `.init(${fields.join(", ")})`;
  }
  throw new Error(`No Swift literal for ${typeof value}`);
}

function table(year: number): string {
  const lines = Object.entries(getTaxTable(year)).map(
    ([key, value]) => `        table.${key} = ${literal(value)}`,
  );
  return [
    `    static let table${year}: BelgianTaxTable = {`,
    "        var table = BelgianTaxTable()",
    ...lines,
    "        return table",
    "    }()",
  ].join("\n");
}

export function generateTaxTables(): string {
  return [
    generatedHeader(SOURCE, COMMAND),
    "extension BelgianTaxTable {",
    `    static let supportedYears: [Double] = ${literal(SUPPORTED_TAX_YEARS)}`,
    `    static let earliestYear: Double = ${EARLIEST_TAX_YEAR}`,
    `    static let latestYear: Double = ${LATEST_TAX_YEAR}`,
    `    static let defaultCommunalSurchargeByRegion: ByRegion<Double> = ${literal(DEFAULT_COMMUNAL_SURCHARGE)}`,
    `    static let byYear: [BelgianTaxTable] = [${SUPPORTED_TAX_YEARS.map((year) => `table${year}`).join(", ")}]`,
    "",
    SUPPORTED_TAX_YEARS.map(table).join("\n\n"),
    "}",
    "",
  ].join("\n");
}

if (isEntrypoint(import.meta))
  writeGenerated(repoPath(OUTPUT), generateTaxTables());
