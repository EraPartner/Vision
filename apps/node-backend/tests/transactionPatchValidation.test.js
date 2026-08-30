import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockLogger } from "./helpers/mockLogger.js";
import { mockConnection } from "./helpers/repoMocks.js";
import { routeAgent, errEnvelope } from "./helpers/routeApp.js";
import {
  mockDeduplication,
  mockCurrencyConversion,
  mockTransferReconciliation,
} from "./helpers/transactionsRouteMocks.js";

// PATCH /api/transactions/:id validation parity (TODO E8): the handler
// whitelist-filtered only — a cleared inline date ('') survived to Postgres
// as `SET "date" = ''` (22007 → 500), and non-numeric amount / non-integer
// FK ids surfaced as DB cast errors instead of 400s.

vi.mock("../src/database/connection.js", () =>
  mockConnection({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
);
vi.mock("../src/services/transactionService.js", () => ({
  default: {
    update: vi
      .fn()
      .mockResolvedValue({ id: 1, amount: "10", date: "2026-07-01" }),
  },
}));
vi.mock("../src/services/deduplication.js", () => mockDeduplication());
vi.mock("../src/services/currency/currencyConversionService.js", () =>
  mockCurrencyConversion(),
);
vi.mock("../src/config/logger.js", () => ({
  logger: mockLogger(),
}));
vi.mock("../src/services/transferReconciliationService.js", () =>
  mockTransferReconciliation(),
);
vi.mock("../src/services/plannedMatchService.js", () => ({
  autoLinkTransactions: vi.fn(),
}));
vi.mock("../src/services/transactionExport.js", () => ({
  EXPORT_MAX_LIST_SIZE: 1000,
  streamCsvExport: vi.fn(),
  streamNdjsonExport: vi.fn(),
  streamBulkTransactionExport: vi.fn(),
}));

import transactionRepository from "../src/services/transactionService.js";

const { default: transactionsRouter } =
  await import("../src/routes/transactions.js");

const api = routeAgent(transactionsRouter, { mountPath: "/api/transactions" });

const runPatch = (body) => api.patch("/api/transactions/1").send(body);

beforeEach(() => {
  vi.clearAllMocks();
  transactionRepository.update.mockResolvedValue({
    id: 1,
    amount: "10",
    date: "2026-07-01",
  });
});

describe("PATCH /api/transactions/:id validation", () => {
  it("rejects a cleared date instead of forwarding SET \"date\" = ''", async () => {
    let res = await runPatch({ date: "" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));

    res = await runPatch({ transaction_date: null });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));

    expect(transactionRepository.update).not.toHaveBeenCalled();
  });

  it("rejects a malformed date", async () => {
    const res = await runPatch({ date: "banana" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
  });

  it("accepts a valid Y-M-D date and remaps it to transaction_date", async () => {
    const res = await runPatch({ date: "2026-07-01" });
    expect(res.status).toBe(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ transaction_date: "2026-07-01" }),
    );
  });

  it("rejects non-numeric or cleared amounts", async () => {
    for (const amount of ["abc", null, ""]) {
      const res = await runPatch({ amount });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));
    }
  });

  it("coerces a numeric-string amount", async () => {
    const res = await runPatch({ amount: "-12.5" });
    expect(res.status).toBe(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ amount: -12.5 }),
    );
  });

  it("rejects non-integer FK ids but lets null clear them", async () => {
    let res = await runPatch({ recipient_id: "abc" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));

    res = await runPatch({ category_id: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(errEnvelope({ code: "VALIDATION_ERROR" }));

    res = await runPatch({ recipient_id: null, category_id: null });
    expect(res.status).toBe(200);
    expect(transactionRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ recipient_id: null, category_id: null }),
    );
  });
});
