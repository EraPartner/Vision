import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lockPortfolioTransactionWrites: vi.fn(),
  getAuditByIdempotencyKey: vi.fn(),
  lockEligibleDestinationAccount: vi.fn(),
  lockTransactions: vi.fn(),
  getUnitEventsForInvestments: vi.fn(),
  getHistoricalRates: vi.fn(),
  compareAndSetAccount: vi.fn(),
  insertAudit: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock("../src/database/connection.js", () => ({
  withTransaction: (fn) => fn(),
}));

vi.mock("../src/repositories/portfolioBrokerRetagRepository.js", () => ({
  default: mocks,
}));

vi.mock("../src/repositories/settingsRepository.js", () => ({
  settingsRepository: { get: mocks.getSetting },
}));

import {
  assertRetagPreservesPortfolioEconomics,
  assertRetagPreservesPartitionUnits,
  fingerprintRetagRequest,
  retagPortfolioTransactions,
} from "../src/services/portfolio/portfolioBrokerRetagService.js";
import {
  ConflictError,
  ValidationError,
} from "../src/middleware/errorHandler.js";

const request = {
  transaction_ids: [12, 11],
  from_account_id: 4,
  to_account_id: 7,
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
    mocks.getAuditByIdempotencyKey.mockResolvedValue(undefined);
    mocks.lockEligibleDestinationAccount.mockResolvedValue({ id: 7 });
    mocks.lockTransactions.mockResolvedValue(selected);
    mocks.getUnitEventsForInvestments.mockResolvedValue(histories);
    mocks.getHistoricalRates.mockResolvedValue([]);
    mocks.compareAndSetAccount.mockResolvedValue([11, 12]);
    mocks.insertAudit.mockImplementation(async (value) => ({
      id: "91",
      ...value,
      created_at: "2026-09-07T12:00:00.000Z",
    }));
    mocks.getSetting.mockResolvedValue("weighted_avg");
  });

  it("sorts the set, applies one compare-and-set update, and returns a receipt", async () => {
    const result = await retagPortfolioTransactions(request);

    expect(
      mocks.lockEligibleDestinationAccount.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.lockPortfolioTransactionWrites.mock.invocationCallOrder[0],
    );
    expect(mocks.lockPortfolioTransactionWrites).toHaveBeenCalledOnce();
    expect(mocks.getAuditByIdempotencyKey).toHaveBeenCalledTimes(2);
    expect(mocks.lockTransactions).toHaveBeenCalledWith([11, 12]);
    expect(mocks.compareAndSetAccount).toHaveBeenCalledWith([11, 12], 4, 7);
    expect(mocks.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction_ids: [11, 12],
        selected_count: 2,
        changed_count: 2,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        receipt_id: 91,
        transaction_ids: [11, 12],
        changed_count: 2,
        replayed: false,
      }),
    );
  });

  it("returns the durable receipt without repeating validation or mutation", async () => {
    mocks.getAuditByIdempotencyKey.mockResolvedValue({
      id: "91",
      idempotency_key: request.idempotency_key,
      request_fingerprint: fingerprintRetagRequest(request),
      from_account_id: 4,
      to_account_id: 7,
      transaction_ids: [11, 12],
      previous_assignments: [],
      selected_count: 2,
      changed_count: 2,
      created_at: "2026-09-07T12:00:00.000Z",
    });

    const result = await retagPortfolioTransactions(request);

    expect(result.replayed).toBe(true);
    expect(mocks.lockEligibleDestinationAccount).not.toHaveBeenCalled();
    expect(mocks.lockPortfolioTransactionWrites).not.toHaveBeenCalled();
    expect(mocks.lockTransactions).not.toHaveBeenCalled();
    expect(mocks.compareAndSetAccount).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key with a different body", async () => {
    mocks.getAuditByIdempotencyKey.mockResolvedValue({
      request_fingerprint: "different",
    });
    await expect(retagPortfolioTransactions(request)).rejects.toBeInstanceOf(
      ConflictError,
    );
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
      to_account_id: 4,
    });
    expect(mocks.compareAndSetAccount).not.toHaveBeenCalled();
    expect(result.changed_count).toBe(0);
  });

  it("rejects a projected per-account oversell", () => {
    expect(() =>
      assertRetagPreservesPartitionUnits(histories, new Set([11]), 7),
    ).toThrow(ValidationError);
  });

  it("allows moving a buy and its dependent sell as one batch", () => {
    expect(() =>
      assertRetagPreservesPartitionUnits(histories, new Set([11, 12]), 7),
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
        transactions,
        new Set([11, 12]),
        7,
        "fifo",
        "2026-09-08",
      ),
    ).toThrow(/change (totalInvested|realizedGain).*fifo/);
    expect(() =>
      assertRetagPreservesPortfolioEconomics(
        transactions,
        new Set([11, 12]),
        7,
        "lifo",
        "2026-09-08",
      ),
    ).toThrow(/change (totalInvested|realizedGain).*lifo/);
  });

  it("allows a partition rename that preserves production economics", () => {
    expect(() =>
      assertRetagPreservesPortfolioEconomics(
        histories.map((row) => ({
          ...row,
          amount: row.type === "buy" ? 100 : 60,
          fees: 0,
          taxes: 0,
          asset_class: "stock",
        })),
        new Set([11, 12]),
        7,
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
        transactions,
        new Set([11, 12]),
        7,
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
        transactions,
        new Set([11, 12]),
        7,
        "fifo",
        "2026-09-08",
        usdRates,
      ),
    ).toThrow(/change USD (totalInvested|realizedGain).*fifo/);
  });

  it("rejects unverifiable non-EUR history instead of guessing", () => {
    expect(() =>
      assertRetagPreservesPortfolioEconomics(
        [
          {
            ...histories[0],
            amount: 100,
            fees: 0,
            taxes: 0,
            currency: "USD",
            fx_multiplier_eur: null,
            asset_class: "stock",
          },
        ],
        new Set([11]),
        7,
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

  it("treats transaction IDs as a set when fingerprinting", () => {
    expect(fingerprintRetagRequest(request)).toBe(
      fingerprintRetagRequest({ ...request, transaction_ids: [11, 12] }),
    );
  });
});
