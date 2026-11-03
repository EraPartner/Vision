/**
 * POST /bulk-export — id-mode + filter-mode streaming, format gate.
 *
 * Driven over HTTP against the real router (tests/helpers/routeApp.ts), so the
 * streamed body and the download headers are read off a real response instead
 * of `res.write`/`res.setHeader` spies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockConnection } from "../helpers/repoMocks.ts";
import {
  mockTransactionRepository,
  mockDeduplication,
  mockMaterializedViews,
  mockCurrencyConversion,
} from "../helpers/transactionsRouteMocks.ts";
import { mockLogger } from "../helpers/mockLogger.ts";
import { routeAgent } from "../helpers/routeApp.ts";

vi.mock("../../src/repositories/transactionRepository.ts", () =>
  mockTransactionRepository(),
);

vi.mock("../../src/services/deduplication.ts", () => mockDeduplication());

vi.mock("../../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

vi.mock("../../src/services/materializedViewService.ts", () =>
  mockMaterializedViews(),
);

vi.mock("../../src/services/currency/currencyConversionService.ts", () =>
  mockCurrencyConversion(),
);

vi.mock("../../src/database/connection.ts", () => mockConnection());

const { default: transactionsRouter } =
  await import("../../src/routes/transactions.ts");

import { withReadSnapshot } from "../../src/database/connection.ts";
import { must } from "../helpers/must.ts";

const api = routeAgent(transactionsRouter, { mountPath: "/api/transactions" });
const bulkExport = (body: object) =>
  api.post("/api/transactions/bulk-export").send(body);

/** Prime the read snapshot's client: every export query runs on it (ADR-263). */
function useSnapshotResults(...results: object[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  vi.mocked(withReadSnapshot).mockImplementation(async (fn) => fn({ query, release: vi.fn() }));
  return { query };
}

// Shaped like a real chunk row: pg DATE as a local-midnight Date, NUMERIC as
// strings.
const SAMPLE_ROW = {
  id: 1,
  date: new Date(2026, 4, 8),
  bank_account: "BE12 3456",
  account_id: 1,
  recipient_name: "Trader Joe",
  memo: "Groceries",
  amount: "-42.5000",
  currency: "EUR",
  balance: "100.0000",
  category_name: "FOOD:GROCERIES",
  comment: "",
  tags: ["weekly"],
};

describe("POST /bulk-export — validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects unknown format", async () => {
    await bulkExport({ ids: [1], format: "xml" }).expect(400);
  });

  it("rejects when neither ids nor filter is given", async () => {
    await bulkExport({ format: "csv" }).expect(400);
  });
});

describe("POST /bulk-export — CSV success", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streams CSV header and a single row to the response", async () => {
    const { query } = useSnapshotResults(
      { rows: [{ n: 1 }] }, // exact existing row count
      { rows: [{ "?column?": 1 }] }, // probe
      { rows: [SAMPLE_ROW] }, // chunk
    );

    const res = await bulkExport({ ids: [1], format: "csv" }).expect(200);

    expect(res.headers["content-type"]).toBe("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/transactions_export_/);
    expect(res.headers["x-exported-count"]).toBe("1");

    expect(res.text).toMatch(/^Date,Bank Account,Recipient/);
    expect(res.text).toContain("Trader Joe");
    expect(res.text).toContain("weekly");
    // One snapshot holds every read of the export.
    expect(withReadSnapshot).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("ends the snapshot with the error when streaming fails", async () => {
    useSnapshotResults({ rows: [{ n: 1 }] }, { rows: [] });

    await bulkExport({ ids: [1], format: "csv" }).expect(404);

    expect(withReadSnapshot).toHaveBeenCalledOnce();
    await expect(
      must(vi.mocked(withReadSnapshot).mock.results[0], "snapshot result").value,
    ).rejects.toThrow();
  });
});

describe("POST /bulk-export — NDJSON success", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streams one JSON object per line", async () => {
    useSnapshotResults(
      { rows: [{ n: 1 }] },
      { rows: [{ "?column?": 1 }] },
      { rows: [SAMPLE_ROW] },
    );

    const res = await bulkExport({ ids: [1], format: "json" }).expect(200);

    expect(res.headers["content-type"]).toBe("application/x-ndjson");
    expect(res.headers["x-exported-count"]).toBe("1");

    const firstLine = res.text.split("\n").filter(Boolean)[0];
    const parsed = JSON.parse(must(firstLine, "firstLine")) as Record<
      string,
      unknown
    >;
    expect(parsed.id).toBe(1);
    expect(parsed.recipient).toBe("Trader Joe");
    expect(parsed.tags).toEqual(["weekly"]);
  });
});

describe("POST /bulk-export — filter-mode resolves through bulk selection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects filter requests over the cap", async () => {
    useSnapshotResults({ rows: [{ n: 7000 }] });

    await bulkExport({
      filter: { search: "big" },
      expected_count: 5000,
      format: "csv",
    }).expect(400);
  });
});
