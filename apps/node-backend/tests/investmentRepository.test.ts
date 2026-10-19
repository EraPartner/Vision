import { describe, it, expect, vi, beforeEach } from "vitest";

import { mockTxConnection } from "./helpers/repoMocks.ts";
import {
  asCurrencyCode,
  asInvestmentId,
} from "@vision/types/brands";
vi.mock("../src/database/connection.ts", () => mockTxConnection());

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import investmentRepository from "../src/repositories/investmentRepository.ts";
import { partial } from "./helpers/partial.ts";
import { investmentDbRow } from "./helpers/portfolioPgRows.ts";

const query = vi.mocked(rawQuery);

describe("investmentRepository.create symbol uniqueness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects a duplicate symbol on create with the same error shape as update", async () => {
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [{ id: 7 }] })); // uniqueness check finds a match

    await expect(
      investmentRepository.create({
        name: "Apple",
        symbol: " aapl ",
        asset_class: "stock",
        currency: asCurrencyCode("USD"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "symbol must be unique",
    });

    // Normalized (trim/uppercase) before the check.
    expect(query.mock.calls[0]?.[1]).toContain("AAPL");
    expect(query).toHaveBeenCalledTimes(1); // nothing written
  });

  it("skips the uniqueness check when no symbol is provided", async () => {
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({
        rows: [
          investmentDbRow({ id: asInvestmentId(12), asset_class: "savings", name: "Book" }),
        ],
      }),
    );

    const result = await investmentRepository.create({
      name: "Book",
      asset_class: "savings",
      currency: asCurrencyCode("EUR"),
      interest_rate: 2,
    });

    expect(result).toMatchObject({
      id: 12,
      asset_class: "savings",
      name: "Book",
    });
    expect(query).toHaveBeenCalledTimes(1); // the INSERT only
  });
});

describe("investmentRepository.update", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects changing asset_class", async () => {
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({
        rows: [investmentDbRow({ id: asInvestmentId(2), asset_class: "stock" })],
      }),
    );

    await expect(
      investmentRepository.update(asInvestmentId(2), { asset_class: "etf" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "asset_class cannot be changed",
    });
  });

  it("rejects empty symbol", async () => {
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({
        rows: [investmentDbRow({ id: asInvestmentId(3), asset_class: "stock", symbol: "OLD" })],
      }),
    );

    await expect(
      investmentRepository.update(asInvestmentId(3), { symbol: "   " }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "symbol is required",
    });
  });

  it("normalizes symbol and enforces uniqueness", async () => {
    query
      .mockResolvedValueOnce(
        partial<PgQueryResult>({
          rows: [
            investmentDbRow({ id: asInvestmentId(4), asset_class: "stock", symbol: "OLD" }),
          ],
        }),
      )
      .mockResolvedValueOnce(partial<PgQueryResult>({ rows: [{ id: 99 }] }));

    await expect(
      investmentRepository.update(asInvestmentId(4), { symbol: " aapl " }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "symbol must be unique",
    });

    // Normalized symbol, excluding the investment being updated.
    expect(query.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["AAPL", 4]),
    );
  });
});

describe("investmentRepository.updatePrice", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null for a missing investment", async () => {
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [] }));

    const result = await investmentRepository.updatePrice(asInvestmentId(404), {
      current_price: 1,
      price_updated_at: null,
    });

    expect(result).toBeNull();
  });
});

describe("investmentRepository.updatePricesBulk", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 0 for an empty batch without querying", async () => {
    expect(await investmentRepository.updatePricesBulk([])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("investmentRepository.hardDelete", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns false when nothing was deleted", async () => {
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rowCount: 0 }));

    expect(await investmentRepository.hardDelete(asInvestmentId(11))).toBe(false);
  });
});

describe("investmentRepository read helpers and extra branches", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("supports getAll/getCount/getAllWithCount/getById branch paths", async () => {
    query
      .mockResolvedValueOnce(
        partial<PgQueryResult>({
          rows: [investmentDbRow({ id: asInvestmentId(1), name: "A" })],
        }),
      )
      .mockResolvedValueOnce(partial<PgQueryResult>({ rows: [{ count: "3" }] }))
      .mockResolvedValueOnce(
        partial<PgQueryResult>({
          rows: [
            { ...investmentDbRow({ id: asInvestmentId(2), name: "B" }), total_count: "5" },
          ],
        }),
      )
      .mockResolvedValueOnce(partial<PgQueryResult>({ rows: [] }));

    const all = await investmentRepository.getAll({
      limit: 10,
      offset: 0,
      active: false,
      assetClass: "stock",
    });
    const count = await investmentRepository.getCount({
      active: false,
      assetClass: "stock",
    });
    const withCount = await investmentRepository.getAllWithCount({
      limit: 1,
      offset: 2,
      active: true,
      assetClass: null,
    });
    const byId = await investmentRepository.getById(asInvestmentId(999));

    expect(all).toHaveLength(1);
    expect(count).toBe(3);
    expect(withCount.total).toBe(5);
    expect(withCount.rows[0]).toMatchObject({ id: 2, name: "B" });
    expect(byId).toBeNull();
  });

  it("returns existing row when update has no allowed fields", async () => {
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({
        rows: [investmentDbRow({ id: asInvestmentId(5), asset_class: "stock", name: "AAPL" })],
      }),
    );

    const result = await investmentRepository.update(asInvestmentId(5), { unknownField: "x" });

    expect(result).toMatchObject({ id: 5, asset_class: "stock", name: "AAPL" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns null when updating non-existing investment", async () => {
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [] }));

    const result = await investmentRepository.update(asInvestmentId(404), { name: "Nope" });

    expect(result).toBeNull();
  });

  it("throws for an unsupported asset class in create", async () => {
    // Must be a VALIDATION_ERROR so the controller maps it to a 400, not a 500
    // (translateRepoError in investmentService keys on this code).
    await expect(
      investmentRepository.create({
        name: "X",
        asset_class: "unsupported",
        currency: asCurrencyCode("EUR"),
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Unsupported asset_class: unsupported",
    });
    expect(query).not.toHaveBeenCalled();
  });
});
