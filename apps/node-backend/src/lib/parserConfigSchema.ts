/**
 * Saved custom-parser config schemas (`custom_parser_configs.config_json`),
 * shared by the request side (POST/PATCH /parsers on both import routers) and
 * the read side (customParserConfigRepository re-validates stored rows).
 *
 * The repository check reuses the save-path schemas on purpose: a stored config
 * the save path would reject can neither have been written by the current code
 * nor be re-saved by the frontend, so it is a data-contract violation.
 *
 * Lives in lib/ because repositories must not import services (ADR-067).
 */
import { z } from "zod";
import { ValidationError } from "../middleware/errorHandler.ts";
import { validateId } from "./validation.ts";
import { VALID_ASSET_CLASSES } from "./assetClasses.ts";
import {
  normalizeCsvEncoding,
  CSV_NUMBER_FORMATS,
} from "./csvFormatOptions.ts";

function normalizeEncodingOrIssue(value: unknown, ctx: z.RefinementCtx) {
  try {
    return normalizeCsvEncoding(value);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    ctx.addIssue({ code: "custom", message: error.message });
    return z.NEVER;
  }
}

/**
 * A CSV encoding field: absent/empty normalizes to `utf-8`; an unsupported
 * value becomes an issue carrying normalizeCsvEncoding's message.
 */
export const csvEncodingField = z
  .unknown()
  .optional()
  .transform(normalizeEncodingOrIssue);

/** As {@link csvEncodingField}, but an absent value stays absent. */
const optionalCsvEncodingField = z
  .unknown()
  .transform(normalizeEncodingOrIssue)
  .optional();

/**
 * An optional account id: absent/`''` is `undefined`, anything else must pass
 * `validateId` (not `Number()`, which retargets `'1e3'` to account 1000).
 */
export function optionalAccountIdField(field: string) {
  return z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (value == null || value === "") return undefined;
      const parsed = validateId(value, field);
      if (!parsed.valid) {
        ctx.addIssue({
          code: "custom",
          message: `${field} must be a positive integer`,
        });
        return z.NEVER;
      }
      return parsed.value;
    });
}

// Transaction parser configs (camelCase CustomConfig shape). Strip mode drops
// unknown keys, exactly like the old hand-built return object. NOTE: unlike
// the live import endpoints, separator deliberately has no single-char rule
// here (pre-zod parity — any non-empty string sticks).
const requiredConfigColumn = (key: string) =>
  z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (!value || typeof value !== "string" || value.trim().length === 0) {
        ctx.addIssue({ code: "custom", message: `config.${key} is required` });
        return z.NEVER;
      }
      return value.trim();
    });

export const parserConfigSchema = z.object({
  dateColumn: requiredConfigColumn("dateColumn"),
  recipientColumn: requiredConfigColumn("recipientColumn"),
  amountColumn: requiredConfigColumn("amountColumn"),
  memoColumn: z
    .unknown()
    .optional()
    .transform((value) => (typeof value === "string" ? value.trim() : "")),
  dateFormat: z
    .unknown()
    .optional()
    .transform((value) =>
      typeof value === "string" && value.trim() ? value.trim() : "%Y-%m-%d",
    ),
  separator: z
    .unknown()
    .optional()
    .transform((value) =>
      typeof value === "string" && value.length ? value : ",",
    ),
  encoding: csvEncodingField,
  number_format: z.enum(CSV_NUMBER_FORMATS).default("auto"),
  skipRows: z
    .unknown()
    .optional()
    .transform((value) => {
      const skipRows = parseInt(String(value), 10);
      return Number.isFinite(skipRows) && skipRows > 0 ? skipRows : 0;
    }),
});

// Portfolio parser configs: the frontend's PortfolioCustomConfig (camelCase).
// Required: dateColumn, a symbol or name column, and a valid defaultAssetClass.
// Loose, so additional parser keys are preserved.
export const portfolioParserConfigSchema = z
  .looseObject({
    number_format: z.enum(CSV_NUMBER_FORMATS).default("auto"),
    encoding: optionalCsvEncodingField,
    dateColumn: z
      .unknown()
      .optional()
      .transform((value, ctx) => {
        if (!value || typeof value !== "string" || !value.trim()) {
          ctx.addIssue({
            code: "custom",
            message: "config.dateColumn is required",
          });
          return z.NEVER;
        }
        return value;
      }),
    defaultAssetClass: z.enum([...VALID_ASSET_CLASSES], {
      error: "config.defaultAssetClass must be a valid asset class",
    }),
    transferDestinationAccountId: optionalAccountIdField(
      "config.transferDestinationAccountId",
    ),
    transferOriginAccountId: optionalAccountIdField(
      "config.transferOriginAccountId",
    ),
    yieldBasisPolicy: z.literal("zero").optional(),
    accountId: optionalAccountIdField("config.accountId"),
  })
  .superRefine((config, ctx) => {
    const hasSymbol =
      typeof config.symbolColumn === "string" && config.symbolColumn.trim();
    const hasName =
      typeof config.nameColumn === "string" && config.nameColumn.trim();
    if (!hasSymbol && !hasName) {
      ctx.addIssue({
        code: "custom",
        message: "config requires symbolColumn or nameColumn",
      });
    }
  });

/** A stored row's `kind` + parsed `config_json`, checked against its kind's schema. */
export const storedParserConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transaction"), config: parserConfigSchema }),
  z.object({
    kind: z.literal("portfolio"),
    config: portfolioParserConfigSchema,
  }),
]);
