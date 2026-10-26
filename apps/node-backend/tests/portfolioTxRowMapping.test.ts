import { describe, it, expect, vi } from "vitest";
import { asPortfolioTransactionId } from "@vision/types/brands";
import { portfolioTransactionDbRow } from "./helpers/portfolioPgRows.ts";
import { mockConnection } from "./helpers/repoMocks.ts";

vi.mock("../src/database/connection.ts", () => mockConnection());

import { mapPortfolioTxRow } from "../src/repositories/portfolioTxRepo.reads.ts";

describe("mapPortfolioTxRow — wire shape", () => {
  it("emits DATE columns as calendar-day strings, not raw pg Dates", () => {
    // pg parses DATE into a local-midnight Date; JSON-serializing that emits
    // an ISO timestamp of the PREVIOUS day east of UTC, which the edit dialog
    // T-split and wrote back — date−1 per save.
    const prevTz = process.env.TZ;
    process.env.TZ = "Europe/Brussels";
    try {
      const row = mapPortfolioTxRow(portfolioTransactionDbRow({
        id: asPortfolioTransactionId(1),
        date: new Date(2026, 6, 1), // local midnight July 1 (pg shape)
        recurrence_end_date: new Date(2026, 11, 31),
        amount: "1000.50",
        units: "10",
      }));
      expect(row.date).toBe("2026-07-01");
      expect(row.recurrence_end_date).toBe("2026-12-31");
      expect(row.amount).toBe(1000.5); // NUMERIC coercion still applies
    } finally {
      process.env.TZ = prevTz;
    }
  });

  it("passes null dates and batch ids through untouched", () => {
    const row = mapPortfolioTxRow(portfolioTransactionDbRow({
      id: asPortfolioTransactionId(2),
      date: new Date(2026, 6, 1),
      recurrence_end_date: null,
      amount: "1",
      import_batch_id: null,
    }));
    expect(row.date).toBe("2026-07-01");
    expect(row.recurrence_end_date).toBeNull();
    expect(row.import_batch_id).toBeNull();
  });

  it("preserves BIGINT import batch provenance as a string", () => {
    const row = mapPortfolioTxRow(portfolioTransactionDbRow({
      id: asPortfolioTransactionId(3),
      date: new Date(2026, 6, 1),
      import_batch_id: "7",
    }));
    expect(row.import_batch_id).toBe("7");
  });

  it("does not expose internal import identity metadata", () => {
    const row = mapPortfolioTxRow(portfolioTransactionDbRow({
      id: asPortfolioTransactionId(4),
      date: new Date(2026, 6, 1),
      source_record_hash: "source",
      dedup_fingerprint: "fingerprint",
      dedup_fingerprint_version: 1,
    }));
    expect(row).not.toHaveProperty("source_record_hash");
    expect(row).not.toHaveProperty("dedup_fingerprint");
    expect(row).not.toHaveProperty("dedup_fingerprint_version");
  });
});
