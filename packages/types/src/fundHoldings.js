import { z } from "zod";

export const FUND_HOLDINGS_CONTRACT_VERSION = 1;
export const FUND_HOLDING_IDENTIFIER_TYPES = Object.freeze([
  "isin",
  "ticker",
  "sedol",
  "cusip",
  "lei",
  "proprietary",
]);

const decimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/)
  .refine(
    (value) => (value.split(".")[1] ?? "").length <= 12,
    "Weight supports at most 12 fractional digits",
  )
  .refine((value) => Number(value) <= 100, "Weight must not exceed 100");
const dateSchema = z.iso.date();
const dateTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Datetime must use UTC Z notation");

const identifierSchema = z
  .object({
    type: z.enum(FUND_HOLDING_IDENTIFIER_TYPES),
    value: z.string().trim().min(1).max(128),
    exchange: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((identifier, context) => {
    if (identifier.type !== "ticker" && identifier.exchange !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["exchange"],
        message: "Only ticker identifiers may declare an exchange",
      });
    }
    if (
      identifier.type === "isin" &&
      !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(identifier.value)
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "ISIN must use its 12-character canonical form",
      });
    }
  });

function duplicateKeys(values, key) {
  const seen = new Set();
  return values.filter((value) => {
    const current = key(value);
    if (seen.has(current)) return true;
    seen.add(current);
    return false;
  });
}

const identitySchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    identifiers: z.array(identifierSchema).min(1).max(16),
  })
  .strict()
  .superRefine((identity, context) => {
    if (
      duplicateKeys(
        identity.identifiers,
        ({ type, value, exchange }) => `${type}:${exchange ?? ""}:${value}`,
      ).length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["identifiers"],
        message: "Identity identifiers must be unique",
      });
    }
  });

const sourceSchema = z
  .object({
    kind: z.literal("user-supplied-file"),
    providerName: z.string().trim().min(1).max(160).optional(),
    fileName: z.string().trim().min(1).max(512),
    sourceUrl: z.url().optional(),
    asOfDate: dateSchema,
    retrievedAt: dateTimeSchema,
    license: z
      .object({
        status: z.enum([
          "user-provided",
          "permission-confirmed",
          "unknown",
          "restricted",
        ]),
        redistribution: z.enum(["allowed", "forbidden", "unknown"]),
        termsUrl: z.url().optional(),
        note: z.string().trim().min(1).max(1_000).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((source, context) => {
    if (
      source.license.redistribution === "allowed" &&
      source.license.status !== "permission-confirmed"
    ) {
      context.addIssue({
        code: "custom",
        path: ["license", "redistribution"],
        message: "Redistribution requires confirmed permission",
      });
    }
    if (
      source.license.status === "restricted" &&
      source.license.redistribution !== "forbidden"
    ) {
      context.addIssue({
        code: "custom",
        path: ["license", "redistribution"],
        message: "Restricted material must forbid redistribution",
      });
    }
  });

const holdingSchema = z
  .object({
    provenance: z
      .object({
        rowNumber: z.number().int().positive(),
        sheetName: z.string().trim().min(1).max(128).optional(),
      })
      .strict(),
    name: z.string().trim().min(1).max(256),
    identifiers: z.array(identifierSchema).max(16),
    instrumentType: z.enum([
      "equity",
      "bond",
      "cash",
      "fund",
      "derivative",
      "other",
    ]),
    exposureKind: z.enum([
      "direct",
      "cash",
      "nested-fund",
      "derivative",
      "synthetic",
      "unknown",
    ]),
    exposureStatus: z.enum(["supported", "unsupported"]),
    unsupportedReason: z.string().trim().min(1).max(500).optional(),
    weightPercent: decimalSchema,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
  })
  .strict()
  .superRefine((holding, context) => {
    if (holding.instrumentType !== "cash" && holding.identifiers.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["identifiers"],
        message: "Non-cash holdings require an identifier",
      });
    }
    const unsupported = [
      "nested-fund",
      "derivative",
      "synthetic",
      "unknown",
    ].includes(holding.exposureKind);
    if (unsupported && holding.exposureStatus !== "unsupported") {
      context.addIssue({
        code: "custom",
        path: ["exposureStatus"],
        message: `${holding.exposureKind} exposure must be unsupported`,
      });
    }
    if (
      (holding.exposureStatus === "unsupported") !==
      (holding.unsupportedReason !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["unsupportedReason"],
        message:
          "Unsupported exposure requires a reason; supported exposure forbids one",
      });
    }
  });

const coverageSchema = z
  .object({
    status: z.enum(["complete", "partial"]),
    reportedWeightPercent: decimalSchema,
    supportedWeightPercent: decimalSchema,
    unsupportedWeightPercent: decimalSchema,
    missingWeightPercent: decimalSchema,
  })
  .strict();

const stalenessSchema = z
  .object({
    evaluatedAt: dateSchema,
    maximumAgeDays: z.number().int().nonnegative(),
    ageDays: z.number().int().nonnegative(),
    status: z.enum(["current", "stale"]),
  })
  .strict()
  .superRefine((staleness, context) => {
    const expected =
      staleness.ageDays > staleness.maximumAgeDays ? "stale" : "current";
    if (staleness.status !== expected) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Staleness status must be ${expected}`,
      });
    }
  });

function asScaledInteger(value, scale = 12) {
  const [integer, fraction = ""] = value.split(".");
  return (
    BigInt(integer) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0"))
  );
}

export const fundHoldingsDocumentSchema = z
  .object({
    contractVersion: z.literal(FUND_HOLDINGS_CONTRACT_VERSION),
    fund: identitySchema,
    shareClass: identitySchema.extend({
      currency: z.string().regex(/^[A-Z]{3}$/),
    }),
    source: sourceSchema,
    holdings: z.array(holdingSchema).min(1).max(100_000),
    coverage: coverageSchema,
    staleness: stalenessSchema,
  })
  .strict()
  .superRefine((document, context) => {
    const asOfStart = Date.parse(`${document.source.asOfDate}T00:00:00Z`);
    const retrievedAt = Date.parse(document.source.retrievedAt);
    const evaluatedAt = Date.parse(
      `${document.staleness.evaluatedAt}T00:00:00Z`,
    );
    if (retrievedAt < asOfStart) {
      context.addIssue({
        code: "custom",
        path: ["source", "retrievedAt"],
        message: "Retrieval time cannot precede the holdings as-of date",
      });
    }
    const expectedAgeDays = Math.floor((evaluatedAt - asOfStart) / 86_400_000);
    if (expectedAgeDays < 0 || document.staleness.ageDays !== expectedAgeDays) {
      context.addIssue({
        code: "custom",
        path: ["staleness", "ageDays"],
        message:
          "Age must equal whole UTC days from as-of date to evaluation date",
      });
    }
    const rowNumbers = duplicateKeys(
      document.holdings,
      ({ provenance }) =>
        `${provenance.sheetName ?? ""}:${provenance.rowNumber}`,
    );
    if (rowNumbers.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["holdings"],
        message: "Holding row numbers must be unique",
      });
    }
    const identifiers = document.holdings.flatMap((holding) =>
      holding.identifiers.map((identifier) => ({ holding, identifier })),
    );
    if (
      duplicateKeys(
        identifiers,
        ({ identifier: { type, value, exchange } }) =>
          `${type}:${exchange ?? ""}:${value}`,
      ).length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["holdings"],
        message: "Constituent identifiers must be unique across rows",
      });
    }

    const scale = 12;
    const sum = (values) =>
      values.reduce(
        (total, value) => total + asScaledInteger(value, scale),
        0n,
      );
    const totalWeight = sum(
      document.holdings.map(({ weightPercent }) => weightPercent),
    );
    const reportedWeight = asScaledInteger(
      document.coverage.reportedWeightPercent,
      scale,
    );
    const supportedWeight = sum(
      document.holdings
        .filter(({ exposureStatus }) => exposureStatus === "supported")
        .map(({ weightPercent }) => weightPercent),
    );
    const unsupportedWeight = sum(
      document.holdings
        .filter(({ exposureStatus }) => exposureStatus === "unsupported")
        .map(({ weightPercent }) => weightPercent),
    );
    const hundred = asScaledInteger("100", scale);
    const missingWeight = asScaledInteger(
      document.coverage.missingWeightPercent,
      scale,
    );
    if (totalWeight !== reportedWeight) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "reportedWeightPercent"],
        message: "Reported weight must equal the sum of holding rows",
      });
    }
    if (
      supportedWeight !==
      asScaledInteger(document.coverage.supportedWeightPercent, scale)
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "supportedWeightPercent"],
        message: "Supported weight must equal supported holding rows",
      });
    }
    if (
      unsupportedWeight !==
      asScaledInteger(document.coverage.unsupportedWeightPercent, scale)
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "unsupportedWeightPercent"],
        message: "Unsupported weight must equal unsupported holding rows",
      });
    }
    if (reportedWeight + missingWeight !== hundred) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "missingWeightPercent"],
        message: "Reported and missing weight must total 100",
      });
    }
    const expectedCoverage =
      missingWeight === 0n && unsupportedWeight === 0n ? "complete" : "partial";
    if (document.coverage.status !== expectedCoverage) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "status"],
        message: `Coverage status must be ${expectedCoverage}`,
      });
    }
  });

const importIssueSchema = z
  .object({
    code: z.enum([
      "INVALID_FILE",
      "MISSING_FUND_IDENTITY",
      "MISSING_SHARE_CLASS_IDENTITY",
      "INVALID_IDENTIFIER",
      "DUPLICATE_IDENTIFIER",
      "INVALID_WEIGHT",
      "WEIGHT_TOTAL_MISMATCH",
      "STALE_SOURCE",
      "PARTIAL_COVERAGE",
      "UNSUPPORTED_EXPOSURE",
      "LICENSE_RESTRICTION",
      "UNMAPPED_COLUMN",
      "UNSUPPORTED_FORMAT",
    ]),
    severity: z.enum(["warning", "error"]),
    message: z.string().trim().min(1).max(1_000),
    rowNumber: z.number().int().positive().optional(),
    field: z.string().trim().min(1).max(128).optional(),
    rawValue: z.string().max(1_000).optional(),
  })
  .strict();

export const fundHoldingsImportResultSchema = z
  .object({
    contractVersion: z.literal(FUND_HOLDINGS_CONTRACT_VERSION),
    importId: z.string().uuid(),
    status: z.enum(["imported", "partial", "rejected"]),
    fileName: z.string().trim().min(1).max(512),
    parsedAt: dateTimeSchema,
    rowCounts: z
      .object({
        input: z.number().int().nonnegative(),
        accepted: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
      })
      .strict(),
    document: fundHoldingsDocumentSchema.optional(),
    issues: z.array(importIssueSchema).max(10_000),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.rowCounts.accepted + result.rowCounts.rejected !==
      result.rowCounts.input
    ) {
      context.addIssue({
        code: "custom",
        path: ["rowCounts"],
        message: "Accepted and rejected row counts must equal input rows",
      });
    }
    if (
      result.document !== undefined &&
      result.rowCounts.accepted !== result.document.holdings.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["rowCounts", "accepted"],
        message: "Accepted row count must equal normalized holding rows",
      });
    }
    if (
      result.document !== undefined &&
      result.fileName !== result.document.source.fileName
    ) {
      context.addIssue({
        code: "custom",
        path: ["fileName"],
        message: "Result file name must match document source provenance",
      });
    }
    const errors = result.issues.filter(({ severity }) => severity === "error");
    if (
      result.status === "imported" &&
      (errors.length > 0 ||
        result.rowCounts.rejected > 0 ||
        result.document === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Imported results require a document and cannot contain errors or rejected rows",
      });
    }
    if (
      result.status === "partial" &&
      (errors.length === 0 ||
        result.rowCounts.rejected === 0 ||
        result.document === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Partial results require errors and a validated document",
      });
    }
    if (
      result.status === "rejected" &&
      (errors.length === 0 || result.document !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message:
          "Rejected results require errors and cannot contain a document",
      });
    }
  });
