import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockTxConnection } from "./helpers/repoMocks.js";

vi.mock("../src/database/connection.js", () => mockTxConnection());
vi.mock("../src/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/services/currency/currencyConversionService.js", () => ({
  convertToCurrency: vi.fn(async (value) => value),
}));

import { query } from "../src/database/connection.js";
import {
  getBrokerSnapshots,
  __storeCurrentBrokerSnapshot,
} from "../src/services/portfolioPerformanceSnapshotService.js";

describe("forward-only broker snapshots", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replaces only today's split, snapshots names, preserves unassigned identity, and enforces sum parity", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ relation: "portfolio_broker_snapshots" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 7, display_name: "Broker Seven" }],
      })
      .mockResolvedValueOnce({ rows: [{ today: "2026-09-13" }] })
      .mockResolvedValue({ rows: [] });
    const outcome = await __storeCurrentBrokerSnapshot("EUR", {
      totals: { totalPortfolioValue: 125 },
      byAccount: [
        { account_id: 7, currentValue: 100, totalInvested: 80, gainLoss: 20 },
        { account_id: null, currentValue: 25, totalInvested: 20, gainLoss: 5 },
      ],
    });
    expect(outcome).toEqual({
      stored: true,
      rows: 2,
      snapshotDate: "2026-09-13",
    });
    const deleteCall = query.mock.calls.find(([sql]) =>
      sql.includes("DELETE FROM portfolio_broker_snapshots"),
    );
    expect(deleteCall[1]).toEqual(["2026-09-13", "EUR"]);
    const inserts = query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO portfolio_broker_snapshots"),
    );
    expect(inserts[0][1]).toContain("account:7");
    expect(inserts[0][1]).toContain("Broker Seven");
    expect(inserts[1][1]).toContain("unassigned");
    expect(inserts[1][1]).toContain("Unassigned");
  });

  it("refuses a broker split that does not reconcile with the global total", async () => {
    query.mockResolvedValueOnce({
      rows: [{ relation: "portfolio_broker_snapshots" }],
    });
    await expect(
      __storeCurrentBrokerSnapshot("EUR", {
        totals: { totalPortfolioValue: 10 },
        byAccount: [
          { account_id: null, currentValue: 9, totalInvested: 9, gainLoss: 0 },
        ],
      }),
    ).rejects.toThrow("parity failed");
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("DELETE FROM portfolio_broker_snapshots"),
      ),
    ).toBe(false);
  });

  it("reads the frozen snapshot identity rather than resolving current account tags", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ relation: "portfolio_broker_snapshots" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            snapshot_date: "2026-09-12",
            currency: "EUR",
            account_key: "account:7",
            account_id: 7,
            account_name: "Old broker name",
            value: "10.00",
            invested: "8.00",
            gain_loss: "2.00",
            computed_at: "2026-09-12T20:00:00Z",
          },
        ],
      });
    await expect(
      getBrokerSnapshots("2026-09-01", "2026-09-30", "EUR"),
    ).resolves.toEqual([
      expect.objectContaining({
        date: "2026-09-12",
        accountKey: "account:7",
        accountName: "Old broker name",
        value: 10,
      }),
    ]);
  });
});
