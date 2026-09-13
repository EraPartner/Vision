import { describe, expect, it } from "vitest";
import {
  FUND_HOLDINGS_CONTRACT_VERSION,
  fundHoldingsDocumentSchema,
  fundHoldingsImportResultSchema,
} from "@vision/types/fund-holdings";

function clone(value) {
  return structuredClone(value);
}

function messages(parsed) {
  return parsed.error.issues.map(({ message }) => message);
}

const completeDocument = {
  contractVersion: FUND_HOLDINGS_CONTRACT_VERSION,
  fund: {
    name: "Example World Fund",
    identifiers: [{ type: "proprietary", value: "example-world" }],
  },
  shareClass: {
    name: "Example World Fund EUR Acc",
    identifiers: [{ type: "isin", value: "IE00B4L5Y983" }],
    currency: "EUR",
  },
  source: {
    kind: "user-supplied-file",
    providerName: "Example issuer",
    fileName: "example-world-2026-09-01.csv",
    sourceUrl: "https://example.test/holdings",
    asOfDate: "2026-09-01",
    retrievedAt: "2026-09-02T08:30:00Z",
    license: {
      status: "user-provided",
      redistribution: "forbidden",
      note: "Stored for the importing user only.",
    },
  },
  holdings: [
    {
      provenance: { rowNumber: 8, sheetName: "Holdings" },
      name: "Example A",
      identifiers: [{ type: "isin", value: "US0378331005" }],
      instrumentType: "equity",
      exposureKind: "direct",
      exposureStatus: "supported",
      weightPercent: "60",
      currency: "USD",
      countryCode: "US",
    },
    {
      provenance: { rowNumber: 9, sheetName: "Holdings" },
      name: "Example B",
      identifiers: [{ type: "ticker", value: "EXB", exchange: "XNYS" }],
      instrumentType: "equity",
      exposureKind: "direct",
      exposureStatus: "supported",
      weightPercent: "30",
      currency: "USD",
      countryCode: "US",
    },
    {
      provenance: { rowNumber: 10, sheetName: "Holdings" },
      name: "EUR cash",
      identifiers: [],
      instrumentType: "cash",
      exposureKind: "cash",
      exposureStatus: "supported",
      weightPercent: "10",
      currency: "EUR",
    },
  ],
  coverage: {
    status: "complete",
    reportedWeightPercent: "100",
    supportedWeightPercent: "100",
    unsupportedWeightPercent: "0",
    missingWeightPercent: "0",
  },
  staleness: {
    evaluatedAt: "2026-09-12",
    maximumAgeDays: 30,
    ageDays: 11,
    status: "current",
  },
};

describe("fund holdings source and import contract", () => {
  it("accepts a complete user-supplied file with share-class identity, cash, and provenance", () => {
    const parsed = fundHoldingsDocumentSchema.parse(completeDocument);
    expect(parsed.shareClass.identifiers[0]).toEqual({
      type: "isin",
      value: "IE00B4L5Y983",
    });
    expect(parsed.holdings[2]).toMatchObject({
      provenance: { rowNumber: 10, sheetName: "Holdings" },
      instrumentType: "cash",
      weightPercent: "10",
    });
    expect(parsed.source.license.redistribution).toBe("forbidden");

    expect(
      fundHoldingsImportResultSchema.parse({
        contractVersion: 1,
        importId: "9c44e488-d79b-4d1f-932c-c997725db449",
        status: "imported",
        fileName: parsed.source.fileName,
        parsedAt: "2026-09-12T10:00:00Z",
        rowCounts: { input: 3, accepted: 3, rejected: 0 },
        document: parsed,
        issues: [],
      }).status,
    ).toBe("imported");
  });

  it("accepts stale and partial coverage only when both remain explicit", () => {
    const partial = clone(completeDocument);
    partial.holdings[0].weightPercent = "50";
    partial.coverage = {
      status: "partial",
      reportedWeightPercent: "90",
      supportedWeightPercent: "90",
      unsupportedWeightPercent: "0",
      missingWeightPercent: "10",
    };
    partial.source.asOfDate = "2026-07-29";
    partial.source.retrievedAt = "2026-07-30T08:30:00Z";
    partial.staleness = {
      evaluatedAt: "2026-09-12",
      maximumAgeDays: 30,
      ageDays: 45,
      status: "stale",
    };
    expect(fundHoldingsDocumentSchema.parse(partial)).toMatchObject({
      coverage: { status: "partial", missingWeightPercent: "10" },
      staleness: { status: "stale" },
    });

    partial.staleness.status = "current";
    expect(messages(fundHoldingsDocumentSchema.safeParse(partial))).toContain(
      "Staleness status must be stale",
    );
  });

  it("keeps derivative and synthetic exposure unsupported and uncovered", () => {
    for (const exposureKind of ["derivative", "synthetic"]) {
      const partial = clone(completeDocument);
      partial.holdings[1] = {
        ...partial.holdings[1],
        name: `${exposureKind} position`,
        instrumentType: "derivative",
        exposureKind,
        exposureStatus: "unsupported",
        unsupportedReason:
          "Look-through exposure is not modeled by contract version 1.",
      };
      partial.coverage = {
        status: "partial",
        reportedWeightPercent: "100",
        supportedWeightPercent: "70",
        unsupportedWeightPercent: "30",
        missingWeightPercent: "0",
      };
      expect(fundHoldingsDocumentSchema.parse(partial).coverage.status).toBe(
        "partial",
      );

      partial.holdings[1].exposureStatus = "supported";
      delete partial.holdings[1].unsupportedReason;
      expect(messages(fundHoldingsDocumentSchema.safeParse(partial))).toContain(
        `${exposureKind} exposure must be unsupported`,
      );
    }
  });

  it("rejects duplicate identifiers, malformed weights, and inconsistent totals", () => {
    const duplicate = clone(completeDocument);
    duplicate.holdings[1].identifiers = clone(
      duplicate.holdings[0].identifiers,
    );
    expect(messages(fundHoldingsDocumentSchema.safeParse(duplicate))).toContain(
      "Constituent identifiers must be unique across rows",
    );

    const invalidWeight = clone(completeDocument);
    invalidWeight.holdings[0].weightPercent = "60.000";
    expect(fundHoldingsDocumentSchema.safeParse(invalidWeight).success).toBe(
      false,
    );

    const inconsistent = clone(completeDocument);
    inconsistent.coverage.reportedWeightPercent = "99";
    inconsistent.coverage.missingWeightPercent = "1";
    expect(
      messages(fundHoldingsDocumentSchema.safeParse(inconsistent)),
    ).toContain("Reported weight must equal the sum of holding rows");
  });

  it("represents parser failures without accepting an invalid document", () => {
    const rejected = fundHoldingsImportResultSchema.parse({
      contractVersion: 1,
      importId: "81309dc6-d5e1-4f4d-b580-acf23a071a4c",
      status: "rejected",
      fileName: "bad.csv",
      parsedAt: "2026-09-12T10:00:00Z",
      rowCounts: { input: 2, accepted: 0, rejected: 2 },
      issues: [
        {
          code: "DUPLICATE_IDENTIFIER",
          severity: "error",
          message: "ISIN appears on more than one constituent row.",
          rowNumber: 12,
          field: "isin",
          rawValue: "US0378331005",
        },
        {
          code: "INVALID_WEIGHT",
          severity: "error",
          message: "Weight is not a canonical decimal percentage.",
          rowNumber: 13,
          field: "weight",
          rawValue: "unknown",
        },
      ],
    });
    expect(rejected.document).toBeUndefined();

    const falseSuccess = clone(rejected);
    falseSuccess.status = "imported";
    expect(
      messages(fundHoldingsImportResultSchema.safeParse(falseSuccess)),
    ).toContain(
      "Imported results require a document and cannot contain errors or rejected rows",
    );
  });

  it("binds successful row counts and file provenance to the normalized document", () => {
    const wrongCount = {
      contractVersion: 1,
      importId: "9c44e488-d79b-4d1f-932c-c997725db449",
      status: "imported",
      fileName: completeDocument.source.fileName,
      parsedAt: "2026-09-12T10:00:00Z",
      rowCounts: { input: 100, accepted: 100, rejected: 0 },
      document: completeDocument,
      issues: [],
    };
    expect(
      messages(fundHoldingsImportResultSchema.safeParse(wrongCount)),
    ).toContain("Accepted row count must equal normalized holding rows");

    const wrongFile = clone(wrongCount);
    wrongFile.rowCounts = { input: 3, accepted: 3, rejected: 0 };
    wrongFile.fileName = "unrelated.csv";
    expect(
      messages(fundHoldingsImportResultSchema.safeParse(wrongFile)),
    ).toContain("Result file name must match document source provenance");
  });

  it("does not turn source availability into redistribution permission", () => {
    const unlicensed = clone(completeDocument);
    unlicensed.source.license = {
      status: "unknown",
      redistribution: "allowed",
    };
    expect(
      messages(fundHoldingsDocumentSchema.safeParse(unlicensed)),
    ).toContain("Redistribution requires confirmed permission");

    const wrongAge = clone(completeDocument);
    wrongAge.staleness.ageDays = 10;
    expect(messages(fundHoldingsDocumentSchema.safeParse(wrongAge))).toContain(
      "Age must equal whole UTC days from as-of date to evaluation date",
    );
  });
});
