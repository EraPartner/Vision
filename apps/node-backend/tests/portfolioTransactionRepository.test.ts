import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

import { mockConnection } from "./helpers/repoMocks.ts";
import {
  asAccountId,
  asCurrencyCode,
  asInvestmentId,
  asPortfolioTransactionId,
} from "@vision/types/brands";
vi.mock("../src/database/connection.ts", () => mockConnection());
// Domain tests isolate the writer boundary; disposable PG tests verify locks.
vi.mock("../src/services/portfolio/portfolioHistoryWriteService.ts", () => ({
  withPortfolioHistoryWrite: (_accounts: unknown, work: () => unknown) =>
    work(),
}));
vi.mock(
  "../src/repositories/portfolioAssetTransferRepository.ts",
  async () => ({
    ...(await vi.importActual(
      "../src/repositories/portfolioAssetTransferRepository.ts",
    )),
    hasAssetTransfersForInvestment: () => false,
  }),
);

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import portfolioTransactionReadRepository, {
  __resetPortfolioTransactionSchemaCache,
} from "../src/repositories/portfolioTransactionRepository.ts";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.ts";
import type { PortfolioUnitEventDbRow } from "../src/database/rows/portfolio.ts";
import {
  pgLocalDate,
  portfolioTransactionDbRow,
  portfolioUnitEventDbRow,
} from "./helpers/portfolioPgRows.ts";

/** `query` as these tests drive it: SQL text in, a bare `{ rows }` result out. */
const query = vi.mocked(rawQuery) as unknown as Mock<
  (sql: string, params?: readonly unknown[]) => Promise<Partial<PgQueryResult>>
>;

/**
 * Assert the nth `query` call ran `statement` with `params`. The SQL is
 * compared lower-cased without identifier quotes, so it pins which columns a
 * statement writes, not how the query builder spells them.
 */
function expectNthStatement(
  n: number,
  statement: string | RegExp,
  params: readonly unknown[],
) {
  const call = n === -1 ? query.mock.calls.at(-1) : query.mock.calls[n - 1];
  const text = String(call?.[0]).toLowerCase().replace(/"/g, "");
  if (typeof statement === "string") expect(text).toBe(statement.toLowerCase());
  else expect(text).toMatch(statement);
  expect(call?.[1]).toEqual(params);
}

/** A unit-event row dated before the candidates below, with a unique id. */
let nextUnitEventId = 100;
const unitEvent = (
  overrides: Partial<PortfolioUnitEventDbRow>,
): PortfolioUnitEventDbRow =>
  portfolioUnitEventDbRow({
    id: String(nextUnitEventId++),
    date: "2025-01-01",
    ...overrides,
  });

const portfolioTransactionRepository = {
  ...portfolioTransactionReadRepository,
  ...portfolioTransactionService,
};

describe("portfolioTransactionService.create", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it("calculates missing buy/sell field when two of three are provided", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] })
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(30),
            amount: "1000.0000",
            units: "5.00000000",
            price_per_unit: "200.000000",
          }),
        ],
      });

    const result = await portfolioTransactionRepository.create({
      investment_id: asInvestmentId(1),
      type: "buy",
      date: "2026-03-24",
      units: 5,
      price_per_unit: 200,
      currency: asCurrencyCode("EUR"),
    });

    expectNthStatement(
      2,
      /^insert into portfolio_transactions /,
      [
        1,
        "buy",
        "2026-03-24",
        1000,
        5,
        200,
        0,
        0,
        "unknown",
        "EUR",
        null,
        false,
        null,
        null,
        null,
        null,
      ],
    );
    expect(result).toMatchObject({
      income_recognition_role: "standard",
      id: 30,
      amount: 1000,
      units: 5,
      price_per_unit: 200,
    });
  });

  it("rejects buy/sell when fewer than two of amount/units/price_per_unit are provided", async () => {
    query.mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] });

    await expect(
      portfolioTransactionRepository.create({
        investment_id: asInvestmentId(1),
        type: "buy",
        date: "2026-03-24",
        amount: 1000,
        currency: asCurrencyCode("EUR"),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("supports gift as zero-cost asset injection with optional basis", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] })
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(40),
            type: "gift",
            amount: "0.0000",
            units: "2.00000000",
          }),
        ],
      });

    const result = await portfolioTransactionRepository.create({
      investment_id: asInvestmentId(1),
      type: "gift",
      date: "2026-03-24",
      units: 2,
      currency: asCurrencyCode("EUR"),
    });

    expectNthStatement(
      2,
      /^insert into portfolio_transactions /,
      [
        1,
        "gift",
        "2026-03-24",
        0,
        2,
        null,
        0,
        0,
        "unknown",
        "EUR",
        null,
        false,
        null,
        null,
        null,
        null,
      ],
    );
    expect(result).toMatchObject({
      id: 40,
      type: "gift",
      amount: 0,
      units: 2,
      income_recognition_role: "standard",
    });
  });

  it("rejects sell transaction when sell units exceed holdings on that date", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] })
      .mockResolvedValueOnce({
        rows: [unitEvent({ type: "buy", units: "1.00000000" })],
      });

    await expect(
      portfolioTransactionRepository.create({
        investment_id: asInvestmentId(1),
        type: "sell",
        date: "2026-03-24",
        amount: 1000,
        units: 2,
        price_per_unit: 500,
        currency: asCurrencyCode("EUR"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "sell units exceed available holdings",
    });
  });
});

describe("portfolioTransactionRepository.hardDelete", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it("returns false when delete affects no rows", async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });

    const deleted = await portfolioTransactionRepository.hardDelete(asPortfolioTransactionId(99));

    expect(deleted).toBe(false);
  });
});

describe("portfolioTransactionService.remove", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it("rejects deleting a buy when the remaining broker history would oversell", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(44),
            investment_id: asInvestmentId(1),
            type: "buy",
            date: pgLocalDate("2025-01-01"),
            units: "5",
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] })
      .mockResolvedValueOnce({
        rows: [
          unitEvent({
            id: "44",
            type: "buy",
            date: "2025-01-01",
            units: "5",
            account_id: asAccountId(1),
          }),
          unitEvent({
            id: "45",
            type: "buy",
            date: "2025-01-02",
            units: "5",
            account_id: asAccountId(1),
          }),
          unitEvent({
            id: "46",
            type: "sell",
            date: "2025-02-01",
            units: "7",
            account_id: asAccountId(1),
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ display_name: "Broker A", name: "Broker" }],
      });

    await expect(
      portfolioTransactionRepository.remove(asPortfolioTransactionId(44)),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message:
        "change would create or worsen an oversold partition at Broker A",
    });
    expect(
      query.mock.calls.some(([sql]) => /^delete/i.test(String(sql))),
    ).toBe(false);
  });

  it("allows deleting a sell that improves a legacy oversold history", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(46),
            investment_id: asInvestmentId(1),
            type: "sell",
            date: pgLocalDate("2025-02-01"),
            units: "7",
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] })
      .mockResolvedValueOnce({
        rows: [
          unitEvent({
            id: "44",
            type: "buy",
            date: "2025-01-01",
            units: "5",
            account_id: asAccountId(1),
          }),
          unitEvent({
            id: "46",
            type: "sell",
            date: "2025-02-01",
            units: "7",
            account_id: asAccountId(1),
          }),
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    await expect(portfolioTransactionRepository.remove(asPortfolioTransactionId(46))).resolves.toBe(true);
    expectNthStatement(
      -1,
      "DELETE FROM portfolio_transactions WHERE id = $1",
      [46],
    );
  });

  it("rejects rolling back imported lots when later sales depend on them", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({
        rows: [{ id: 44, investment_id: 1 }],
      })
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] })
      .mockResolvedValueOnce({
        rows: [
          unitEvent({
            id: "44",
            type: "buy",
            date: "2025-01-01",
            units: "5",
            account_id: asAccountId(1),
          }),
          unitEvent({
            id: "45",
            type: "buy",
            date: "2025-01-02",
            units: "5",
            account_id: asAccountId(1),
          }),
          unitEvent({
            id: "46",
            type: "sell",
            date: "2025-02-01",
            units: "7",
            account_id: asAccountId(1),
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ display_name: "Broker A", name: "Broker" }],
      });

    await expect(
      portfolioTransactionRepository.validateImportBatchRemoval(7),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message:
        "change would create or worsen an oversold partition at Broker A",
    });
    expect(
      query.mock.calls.some(([sql]) =>
        /^delete from "?portfolio_transactions/i.test(String(sql)),
      ),
    ).toBe(false);
  });

  it("allows one rollback to remove a legacy imported buy and its dependent sell together", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] })
      .mockResolvedValueOnce({
        rows: [
          unitEvent({
            id: "44",
            type: "buy",
            date: "2025-01-01",
            units: "5",
            account_id: asAccountId(1),
          }),
          unitEvent({
            id: "46",
            type: "sell",
            date: "2025-02-01",
            units: "5",
            account_id: asAccountId(1),
          }),
        ],
      });

    await expect(
      portfolioTransactionRepository.validateImportBatchRemoval(7, [
        { id: asPortfolioTransactionId(44), investment_id: asInvestmentId(1) },
        { id: asPortfolioTransactionId(46), investment_id: asInvestmentId(1) },
      ]),
    ).resolves.toBeUndefined();

    expect(
      query.mock.calls.some(([sql]) =>
        /^delete from "?portfolio_transactions/i.test(String(sql)),
      ),
    ).toBe(false);
  });
});

describe("portfolioTransactionRepository.update", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it("normalizes buy/sell math on update when one of three fields is omitted", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(8),
            investment_id: asInvestmentId(1),
            type: "buy",
            amount: "1000",
            units: "5",
            price_per_unit: "200",
            fees: "0",
            taxes: "0",
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] })
      // Projected-history check over the realistic dated lot.
      .mockResolvedValueOnce({
        rows: [
          unitEvent({ id: "8", type: "buy", units: "5", date: "2026-01-15" }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(8),
            amount: "1200.0000",
            units: "6.00000000",
            price_per_unit: "200.000000",
          }),
        ],
      });

    const result = await portfolioTransactionRepository.update(asPortfolioTransactionId(8), {
      units: 6,
      price_per_unit: 200,
    });

    expectNthStatement(
      4,
      "UPDATE portfolio_transactions SET units = $1, price_per_unit = $2, amount = $3, fees = $4, taxes = $5 WHERE id = $6 RETURNING *",
      [6, 200, 1200, 0, 0, 8],
    );
    expect(result).toMatchObject({
      income_recognition_role: "standard",
      id: 8,
      amount: 1200,
      units: 6,
      price_per_unit: 200,
    });
  });

  it("rejects buy/sell update when only one of amount/units/price_per_unit is provided", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(10),
            investment_id: asInvestmentId(1),
            type: "buy",
            amount: "1000",
            units: "5",
            price_per_unit: "200",
            fees: "0",
            taxes: "0",
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] });

    await expect(
      portfolioTransactionRepository.update(asPortfolioTransactionId(10), { amount: 1200 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("keeps non-unit buy/sell update behavior amount-only", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(9),
            investment_id: asInvestmentId(2),
            type: "buy",
            amount: "1000",
            fees: "0",
            taxes: "0",
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ asset_class: "bond" }] })
      .mockResolvedValueOnce({
        rows: [portfolioTransactionDbRow({ id: asPortfolioTransactionId(9), amount: "1200.00" })],
      });

    const result = await portfolioTransactionRepository.update(asPortfolioTransactionId(9), {
      amount: 1200,
    });

    expectNthStatement(
      3,
      "UPDATE portfolio_transactions SET amount = $1 WHERE id = $2 RETURNING *",
      [1200, 9],
    );
    expect(result).toMatchObject({
      id: 9,
      amount: 1200,
      income_recognition_role: "standard",
    });
  });

  it("preserves explicit null when clearing the stored FX rate", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(11),
            investment_id: asInvestmentId(2),
            type: "dividend",
            amount: "100",
            currency: asCurrencyCode("USD"),
            fx_rate_to_eur: "0.92",
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] })
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(11),
            investment_id: asInvestmentId(2),
            type: "dividend",
            amount: "100",
            currency: asCurrencyCode("USD"),
            fx_rate_to_eur: null,
          }),
        ],
      });

    const result = await portfolioTransactionRepository.update(asPortfolioTransactionId(11), {
      fx_rate_to_eur: null,
    });

    expectNthStatement(
      3,
      "UPDATE portfolio_transactions SET fx_rate_to_eur = $1 WHERE id = $2 RETURNING *",
      [null, 11],
    );
    expect(result).toMatchObject({
      income_recognition_role: "standard",
      id: 11,
      investment_id: 2,
      type: "dividend",
      amount: 100,
      currency: "USD",
      fx_rate_to_eur: null,
    });
  });

  it("rejects changing transaction type", async () => {
    query.mockResolvedValueOnce({
      rows: [
        portfolioTransactionDbRow({
          id: asPortfolioTransactionId(12),
          investment_id: asInvestmentId(1),
          type: "buy",
          amount: "1000",
          units: "5",
          price_per_unit: "200",
          fees: "0",
          taxes: "0",
        }),
      ],
    });

    await expect(
      portfolioTransactionRepository.update(asPortfolioTransactionId(12), { type: "sell" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "type cannot be changed",
    });
  });

  it("returns null when update target does not exist", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await portfolioTransactionRepository.update(asPortfolioTransactionId(404), {
      note: "x",
    });

    expect(result).toBeNull();
  });

  it("returns existing row unchanged when patch has no allowed fields", async () => {
    query.mockResolvedValueOnce({
      rows: [
        portfolioTransactionDbRow({
          id: asPortfolioTransactionId(21),
          investment_id: asInvestmentId(1),
          type: "dividend",
          amount: "100",
        }),
      ],
    });
    query.mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] });

    const result = await portfolioTransactionRepository.update(asPortfolioTransactionId(21), {
      unsupported: "field",
    });

    expect(result).toMatchObject({
      income_recognition_role: "standard",
      id: 21,
      investment_id: 1,
      type: "dividend",
      amount: 100,
    });
    // getById, then the investment's asset class; no write.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects sell update when sell units exceed holdings on the effective date", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          portfolioTransactionDbRow({
            id: asPortfolioTransactionId(13),
            investment_id: asInvestmentId(1),
            type: "sell",
            date: pgLocalDate("2026-03-24"),
            amount: "1000",
            units: "1",
            price_per_unit: "1000",
            fees: "0",
            taxes: "0",
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ asset_class: "stock" }] })
      .mockResolvedValueOnce({
        rows: [unitEvent({ type: "buy", units: "0.50000000" })],
      });

    await expect(
      portfolioTransactionRepository.update(asPortfolioTransactionId(13), {
        units: 1,
        price_per_unit: 1000,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "sell units exceed available holdings",
    });
  });
});

describe("portfolioTransactionRepository.getAllByInvestmentIds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it("returns empty list when investmentIds normalize to empty", async () => {
    const rows = await portfolioTransactionRepository.getAllByInvestmentIds({
      // @ts-expect-error -- a null id must be dropped by runtime normalization
      investmentIds: ["x", 0, -2, null],
    });

    expect(rows).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  // The existing pins above only used values `Number.parseInt` also rejected
  // ('x', 'invalid'), so they passed either way. These are the ones that made
  // the layer retarget: parseInt took the leading digits, so a malformed entry
  // did not drop out, it named a real investment nobody asked for. The route
  // now 400s on them before this runs (routes are pinned in
  // routes/investmentsIdValidation.test.ts); here they must drop, not resolve.
  it("drops ids the old parseInt truncated into a different investment", async () => {
    const rows = await portfolioTransactionRepository.getAllByInvestmentIds({
      investmentIds: ["12abc", "1e3", "12.5", "0x10", " 7 ", "+7"],
    });

    expect(rows).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("drops the malformed element of a mixed list without dropping the good one", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await portfolioTransactionRepository.getAllByInvestmentIds({
      investmentIds: [asInvestmentId(5), "12abc"],
    });

    expect(query.mock.calls[0]![1]![0]).toEqual([5]);
  });

});

describe("portfolioTransactionRepository.getSummary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetPortfolioTransactionSchemaCache();
  });

  it("returns grouped summary rows for an investment", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          type: "buy",
          income_recognition_role: "standard",
          total_amount: "1000.00",
          total_units: "5.00000000",
          total_fees: "2.00",
          total_taxes: "1.00",
          count: "2",
        },
      ],
    });

    const rows = await portfolioTransactionRepository.getSummary(asInvestmentId(77));

    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/from "?portfolio_transactions/i),
      [77],
    );
    expect(rows).toEqual([
      {
        type: "buy",
        income_recognition_role: "standard",
        total_amount: 1000,
        total_units: 5,
        total_fees: 2,
        total_taxes: 1,
        count: 2,
      },
    ]);
  });
});
