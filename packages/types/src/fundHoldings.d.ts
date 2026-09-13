import type { z } from "zod";

export declare const FUND_HOLDINGS_CONTRACT_VERSION: 1;
export declare const FUND_HOLDING_IDENTIFIER_TYPES: readonly [
  "isin",
  "ticker",
  "sedol",
  "cusip",
  "lei",
  "proprietary",
];

export type FundHoldingIdentifierType =
  (typeof FUND_HOLDING_IDENTIFIER_TYPES)[number];
export interface FundHoldingIdentifier {
  type: FundHoldingIdentifierType;
  value: string;
  exchange?: string;
}
export interface FundHoldingsIdentity {
  name: string;
  identifiers: FundHoldingIdentifier[];
}
export interface FundHoldingRow {
  provenance: { rowNumber: number; sheetName?: string };
  name: string;
  identifiers: FundHoldingIdentifier[];
  instrumentType: "equity" | "bond" | "cash" | "fund" | "derivative" | "other";
  exposureKind:
    "direct" | "cash" | "nested-fund" | "derivative" | "synthetic" | "unknown";
  exposureStatus: "supported" | "unsupported";
  unsupportedReason?: string;
  weightPercent: string;
  currency?: string;
  countryCode?: string;
}
export interface FundHoldingsDocument {
  contractVersion: 1;
  fund: FundHoldingsIdentity;
  shareClass: FundHoldingsIdentity & { currency: string };
  source: {
    kind: "user-supplied-file";
    providerName?: string;
    fileName: string;
    sourceUrl?: string;
    asOfDate: string;
    retrievedAt: string;
    license: {
      status:
        "user-provided" | "permission-confirmed" | "unknown" | "restricted";
      redistribution: "allowed" | "forbidden" | "unknown";
      termsUrl?: string;
      note?: string;
    };
  };
  holdings: FundHoldingRow[];
  coverage: {
    status: "complete" | "partial";
    reportedWeightPercent: string;
    supportedWeightPercent: string;
    unsupportedWeightPercent: string;
    missingWeightPercent: string;
  };
  staleness: {
    evaluatedAt: string;
    maximumAgeDays: number;
    ageDays: number;
    status: "current" | "stale";
  };
}
export type FundHoldingsImportIssueCode =
  | "INVALID_FILE"
  | "MISSING_FUND_IDENTITY"
  | "MISSING_SHARE_CLASS_IDENTITY"
  | "INVALID_IDENTIFIER"
  | "DUPLICATE_IDENTIFIER"
  | "INVALID_WEIGHT"
  | "WEIGHT_TOTAL_MISMATCH"
  | "STALE_SOURCE"
  | "PARTIAL_COVERAGE"
  | "UNSUPPORTED_EXPOSURE"
  | "LICENSE_RESTRICTION"
  | "UNMAPPED_COLUMN"
  | "UNSUPPORTED_FORMAT";
export interface FundHoldingsImportResult {
  contractVersion: 1;
  importId: string;
  status: "imported" | "partial" | "rejected";
  fileName: string;
  parsedAt: string;
  rowCounts: { input: number; accepted: number; rejected: number };
  document?: FundHoldingsDocument;
  issues: Array<{
    code: FundHoldingsImportIssueCode;
    severity: "warning" | "error";
    message: string;
    rowNumber?: number;
    field?: string;
    rawValue?: string;
  }>;
}

export declare const fundHoldingsDocumentSchema: z.ZodType<FundHoldingsDocument>;
export declare const fundHoldingsImportResultSchema: z.ZodType<FundHoldingsImportResult>;
