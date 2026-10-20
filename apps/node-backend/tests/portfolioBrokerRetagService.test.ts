import { beforeEach, describe, expect, it, vi } from "vitest";
import { loose } from "./helpers/partial.ts";
import { mockConnection } from "./helpers/repoMocks.ts";

const mocks = vi.hoisted(() => ({
  lockPortfolioTransactionWrites: vi.fn(),
  lockEligibleDestinationAccount: vi.fn(),
  lockTransactions: vi.fn(),
  getUnitEventsForInvestments: vi.fn(),
  getHistoricalRates: vi.fn(),
  compareAndSetAccount: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock("../src/database/connection.ts", () =>
  mockConnection({ withTransaction: (fn: () => unknown) => fn() }),
);

vi.mock("../src/repositories/portfolioBrokerRetagRepository.ts", () => ({
  default: mocks,
}));

vi.mock("../src/repositories/settingsRepository.ts", () => ({
  settingsRepository: { get: mocks.getSetting },
}));

import {
  __assertRetagPreservesPortfolioEconomics as assertRetagPreservesPortfolioEconomics,
  __assertRetagPreservesPartitionUnits as assertRetagPreservesPartitionUnits,
  __retagPortfolioTransactions as retagPortfolioTransactions,
} from "../src/services/portfolio/portfolioBrokerRetagService.ts";
import {
  asAccountId,
  asPortfolioTransactionId,
} from "@vision/types/brands";
import {
  ConflictError,
  ValidationError,
} from "../src/middleware/errorHandler.ts";

// The fixtures carry NUMERIC columns as numbers where pg returns text; the
// guards coerce both.
type HistoryRows = Parameters<typeof assertRetagPreservesPartitionUnits>[0];

const request = {
  transaction_ids: [asPortfolioTransactionId(12), asPortfolioTransactionId(11)],
  from_account_id: asAccountId(4),
  to_account_id: asAccountId(7),
  idempotency_key: "75557a9d-4dee-453a-9ef6-3b1b56a54b86",
};

const selected = [
  { id: 11, investment_id: 2, account_id: 4 },
  { id: 12, investment_id: 2, account_id: 4 },
];

const histories = [
  {
    id: 11,
    investment_id: 2,
    type: "buy",
    date: "2026-01-01",
    units: 10,
    account_id: 4,
  },
  {
    id: 12,
    investment_id: 2,
    type: "sell",
    date: "2026-02-01",
    units: 3,
    account_id: 4,
  },
];

describe("portfolioBrokerRetagService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lockEligibleDestinationAccount.mockResolvedValue({ id: 7 });
    mocks.lockTransactions.mockResolvedValue(selected);
    mocks.getUnitEventsForInvestments.mockResolvedValue(histories);
    mocks.getHistoricalRates.mockResolvedValue([]);
    mocks.compareAndSetAccount.mockResolvedValue([11, 12]);
    mocks.getSetting.mockResolvedValue("weighted_avg");
  });

  it("sorts the set, applies one compare-and-set update, and returns a receipt", async () => {
    const result = await retagPortfolioTransactions(request);

    expect(
      mocks.lockEligibleDestinationAccount.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.lockPortfolioTransactionWrites.mock.invocationCallOrder[0]!,
    );
    expect(mocks.lockPortfolioTransactionWrites).toHaveBeenCalledOnce();
    expect(mocks.lockTransactions).toHaveBeenCalledWith([11, 12]);
    expect(mocks.compareAndSetAccount).toHaveBeenCalledWith([11, 12], 4, 7);
    expect(result).toEqual({
      idempotency_key: request.idempotency_key,
      from_account_id: 4,
      to_account_id: 7,
      transaction_ids: [11, 12],
      previous_assignments: [
        { transaction_id: 11, account_id: 4 },
        { transaction_id: 12, account_id: 4 },
      ],
      selected_count: 2,
      changed_count: 2,
      replayed: false,
    });
  });

  it("returns a replay receipt when every row is already on the destination", async () => {
    mocks.lockTransactions.mockResolvedValue(
      selected.map((row) => ({ ...row, account_id: 7 })),
    );

    const result = await retagPortfolioTransactions(request);

    expect(result).toMatchObject({
      replayed: true,
      changed_count: 0,
      selected_count: 2,
      previous_assignments: [
        { transaction_id: 11, account_id: 7 },
        { transaction_id: 12, account_id: 7 },
      ],
    });
  });

  it("rejects inactive or non-portfolio destinations", async () => {
    mocks.lockEligibleDestinationAccount.mockResolvedValue(undefined);
    await expect(retagPortfolioTransactions(request)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(mocks.lockTransactions).not.toHaveBeenCalled();
  });

  it("rejects missing or stale compare-and-set rows", async () => {
    mocks.lockTransactions.mockResolvedValue([selected[0]]);
    const error = await retagPortfolioTransactions(request).catch((err) => err);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.details.stale_transaction_ids).toEqual([12]);
    expect(mocks.compareAndSetAccount).not.toHaveBeenCalled();
  });

  it("records a no-op receipt when source and destination are equal", async () => {
    const result = await retagPortfolioTransactions({
      ...request,
      to_account_id: asAccountId(4),
    });
    expect(mocks.compareAndSetAccount).not.toHaveBeenCalled();
    expect(result.changed_count).toBe(0);
  });

  it("rejects a projected per-account oversell", () => {
    expect(() =>
      assertRetagPreservesPartitionUnits(
        loose<HistoryRows>(histories),
        new Set([asPortfolioTransactionId(11)]),
        asAccountId(7),
      ),
    ).toThrow(ValidationError);
  });

  it("allows moving a buy and its dependent sell as one batch", () => {
    expect(() =>
      assertRetagPreservesPartitionUnits(
        loose<HistoryRows>(histories),
        new Set([asPortfolioTransactionId(11), asPortfolioTransactionId(12)]),
        asAccountId(7),
      ),
    ).not.toThrow();
  });

  it("never re-tags a custody event whose id equals a selected transaction id", () => {
    // portfolio_asset_adjustments ids come from their own sequence, so an
    // adjustment can share a number with a selected portfolio transaction.
    const withCustody = [
      {
        id: 30,
        investment_id: 2,
        type: "buy",
        date: "2025-12-01",
        units: 5,
        amount: 50,
        account_id: 9,
      },
      {
        id: "11",
        investment_id: 2,
        type: "asset_adjustment",
        date: "2026-01-01",
        units: 2,
        account_id: 9,
        adjustment_kind: "asset_fee",
        basis_policy: "carried",
      },
      {
        id: 11,
        investment_id: 2,
        type: "buy",
        date: "2026-02-01",
        units: 10,
        amount: 100,
        account_id: 4,
      },
    ];
    expect(() =>
      assertRetagPreservesPartitionUnits(
        loose<HistoryRows>(withCustody),
        new Set([asPortfolioTransactionId(11)]),
        asAccountId(7),
      ),
    ).not.toThrow();
  });

  it("rejects a merge that changes FIFO or LIFO economics", () => {
    const transactions = [
      {
        id: 11,
        investment_id: 2,
        type: "buy",
        date: "2026-01-01",
        units: 10,
        amount: 100,
        fees: 0,
        taxes: 0,
        account_id: 4,
        asset_class: "stock",
      },
      {
        id: 12,
        investment_id: 2,
        type: "sell",
        date: "2026-04-01",
        units: 5,
        amount: 150,
        fees: 0,
        taxes: 0,
        account_id: 4,
        asset_class: "stock",
      },
      {
        id: 21,
        investment_id: 2,
        type: "buy",
        date: "2026-02-01",
        units: 10,
        amount: 200,
        fees: 0,
        taxes: 0,
        account_id: 7,
        asset_class: "stock",
      },
      {
        id: 22,
        investment_id: 2,
        type: "sell",
        date: "2026-03-01",
        units: 5,
        amount: 150,
        fees: 0,
        taxes: 0,
        account_id: 7,
        asset_class: "stock",
      },
    ];

    expect(() =>
      assertRetagPreservesPortfolioEconomics(
        loose<HistoryRows>(transactions),
        new Set([asPortfolioTransactionId(11), asPortfolioTransactionId(12)]),
        asAccountId(7),
        "fifo",
        "2026-09-08",
      ),
    ).toThrow(/change (totalInvested|realizedGain).*fifo/);
    expect(() =>
      assertRetagPreservesPortfolioEconomics(
        loose<HistoryRows>(transactions),
        new Set([asPortfolioTransactionId(11), asPortfolioTransactionId(12)]),
        asAccountId(7),
        "lifo",
        "2026-09-08",
      ),
    ).toThrow(/change (totalInvested|realizedGain).*lifo/);
  });

  it("allows a partition rename that preserves production economics", () => {
    expect(() =>
      assertRetagPreservesPortfolioEconomics(
        loose<HistoryRows>(
          histories.map((row) => ({
            ...row,
            amount: row.type === "buy" ? 100 : 60,
            fees: 0,
            taxes: 0,
            asset_class: "stock",
          })),
        ),
        new Set([asPortfolioTransactionId(11), asPortfolioTransactionId(12)]),
        asAccountId(7),
        "fifo",
        "2026-09-08",
      ),
    ).not.toThrow();
  });

  it("rejects an FX-converted FIFO change even when native totals match", () => {
    const transactions = [
      {
        id: 11,
        investment_id: 2,
        type: "buy",
        date: "2026-01-01",
        units: 10,
        amount: 100,
        fees: 0,
        taxes: 0,
        currency: "USD",
        fx_multiplier_eur: 2,
        account_id: 4,
        asset_class: "stock",
      },
      {
        id: 21,
        investment_id: 2,
        type: "buy",
        date: "2026-02-01",
        units: 10,
        amount: 100,
        fees: 0,
        taxes: 0,
        currency: "EUR",
        fx_multiplier_eur: 1,
        account_id: 7,
        asset_class: "stock",
      },
      {
        id: 22,
        investment_id: 2,
        type: "sell",
        date: "2026-03-01",
        units: 5,
        amount: 150,
        fees: 0,
        taxes: 0,
        currency: "EUR",
        fx_multiplier_eur: 1,
        account_id: 7,
        asset_class: "stock",
      },
      {
        id: 12,
        investment_id: 2,
        type: "sell",
        date: "2026-04-01",
        units: 5,
        amount: 150,
        fees: 0,
        taxes: 0,
        currency: "EUR",
        fx_multiplier_eur: 1,
        account_id: 4,
        asset_class: "stock",
      },
    ];

    expect(() =>
      assertRetagPreservesPortfolioEconomics(
        loose<HistoryRows>(transactions),
        new Set([asPortfolioTransactionId(11), asPortfolioTransactionId(12)]),
        asAccountId(7),
        "fifo",
        "2026-09-08",
      ),
    ).toThrow(/change EUR (totalInvested|realizedGain).*fifo/);
  });

  it("rejects a target-currency FIFO change when EUR totals match", () => {
    const transactions = [
      {
        id: 11,
        investment_id: 2,
        type: "buy",
        date: "2026-01-01",
        units: 10,
        amount: 100,
        currency: "EUR",
        account_id: 4,
        asset_class: "stock",
      },
      {
        id: 21,
        investment_id: 2,
        type: "buy",
        date: "2026-02-01",
        units: 10,
        amount: 100,
        currency: "EUR",
        account_id: 7,
        asset_class: "stock",
      },
      {
        id: 22,
        investment_id: 2,
        type: "sell",
        date: "2026-03-01",
        units: 5,
        amount: 150,
        currency: "EUR",
        account_id: 7,
        asset_class: "stock",
      },
      {
        id: 12,
        investment_id: 2,
        type: "sell",
        date: "2026-04-01",
        units: 5,
        amount: 150,
        currency: "EUR",
        account_id: 4,
        asset_class: "stock",
      },
    ];
    const usdRates = [
      { currency_code: "USD", rate_date: "2026-01-01", rate_to_eur: 0.5 },
      { currency_code: "USD", rate_date: "2026-02-01", rate_to_eur: 1 },
      { currency_code: "USD", rate_date: "2026-03-01", rate_to_eur: 1 },
      { currency_code: "USD", rate_date: "2026-04-01", rate_to_eur: 1 },
    ];

    expect(() =>
      assertRetagPreservesPortfolioEconomics(
        loose<HistoryRows>(transactions),
        new Set([asPortfolioTransactionId(11), asPortfolioTransactionId(12)]),
        asAccountId(7),
        "fifo",
        "2026-09-08",
        usdRates,
      ),
    ).toThrow(/change USD (totalInvested|realizedGain).*fifo/);
  });

  it("rejects unverifiable non-EUR history instead of guessing", () => {
    expect(() =>
      assertRetagPreservesPortfolioEconomics(
        loose<HistoryRows>([
          {
            ...histories[0],
            amount: 100,
            fees: 0,
            taxes: 0,
            currency: "USD",
            fx_multiplier_eur: null,
            asset_class: "stock",
          },
        ]),
        new Set([asPortfolioTransactionId(11)]),
        asAccountId(7),
        "weighted_avg",
        "2026-09-08",
      ),
    ).toThrow(/cannot verify EUR cost basis/);
  });

  it("uses the configured cost-basis method for the transactional guard", async () => {
    mocks.getSetting.mockResolvedValue("fifo");
    mocks.getUnitEventsForInvestments.mockResolvedValue([
      {
        id: 11,
        investment_id: 2,
        type: "buy",
        date: "2026-01-01",
        units: 10,
        amount: 100,
        fees: 0,
        taxes: 0,
        account_id: 4,
        asset_class: "stock",
      },
      {
        id: 12,
        investment_id: 2,
        type: "sell",
        date: "2026-02-01",
        units: 3,
        amount: 60,
        fees: 0,
        taxes: 0,
        account_id: 4,
        asset_class: "stock",
      },
    ]);

    await retagPortfolioTransactions(request);
    expect(mocks.getSetting).toHaveBeenCalledWith("cost_basis_method");
  });

});
