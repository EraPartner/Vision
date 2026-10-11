/**
 * CSV format options shared by the import forms' request validation
 * (lib/parserConfigSchema.ts, the import routers) and the bank and portfolio
 * CSV adapters: the accepted text encodings and numeric cell formats.
 */
import { ValidationError } from "../middleware/errorHandler.ts";

/**
 * Normalize the CSV encodings offered by the import forms and their aliases.
 */
export function normalizeCsvEncoding(
  value: unknown,
): "utf-8" | "latin1" | "windows-1252" {
  if (value === undefined || value === null || value === "") return "utf-8";
  if (typeof value !== "string") {
    throw new ValidationError("Unsupported CSV encoding");
  }
  const encoding = value.trim().toLowerCase();
  if (!encoding || encoding === "utf-8" || encoding === "utf8") return "utf-8";
  if (["latin1", "latin-1", "iso-8859-1"].includes(encoding)) return "latin1";
  if (encoding === "windows-1252") return "windows-1252";
  throw new ValidationError(`Unsupported CSV encoding "${value}"`);
}

export const CSV_NUMBER_FORMATS = [
  "auto",
  "decimal_dot",
  "decimal_comma",
] as const;
export type CsvNumberFormat = (typeof CSV_NUMBER_FORMATS)[number];

function isCsvNumberFormat(value: string): value is CsvNumberFormat {
  const formats: readonly string[] = CSV_NUMBER_FORMATS;
  return formats.includes(value);
}

export function normalizeCsvNumberFormat(value: unknown): CsvNumberFormat {
  if (value === undefined) return "auto";
  if (typeof value !== "string" || !isCsvNumberFormat(value)) {
    throw new ValidationError(
      "number_format must be auto, decimal_dot or decimal_comma",
    );
  }
  return value;
}
