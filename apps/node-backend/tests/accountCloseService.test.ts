import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { mockTxConnection } from "./helpers/repoMocks.ts";

const { mockClient, systemRecipient } = vi.hoisted(() => ({
  mockClient: { query: vi.fn() },
  systemRecipient: vi.fn(),
}));

vi.mock("../src/database/connection.ts", () => mockTxConnection(mockClient));
vi.mock("../src/repositories/recipientRepository.ts", () => ({
  recipientRepository: { getOrCreateSystemId: systemRecipient },
}));

import {
  query as rawQuery,
  withTransaction,
} from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { asAccountId } from "@vision/types/brands";
import {
  closeAccount,
  __normalizeCloseAccount as normalizeCloseAccount,
  previewAccountPortfolioLots,
} from "../src/services/accountCloseService.ts";
import { must } from "./helpers/must.ts";

// The ambient-transaction mock routes module-level `query` onto mockClient.
const query = rawQuery as unknown as Mock<
  (
    text: string,
    params?: readonly unknown[],
  ) => Promise<Partial<PgQueryResult<unknown>>>
>;

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.query.mockReset();
  systemRecipient.mockResolvedValue(900);
});

describe("normalizeCloseAccount", () => {
  it("accepts the two explicit balance outcomes", () => {
    expect(normalizeCloseAccount({ balance_handling: "preserve" })).toBe(
      "preserve",
    );
    expect(normalizeCloseAccount({ balance_handling: "adjustment" })).toBe(
      "adjustment",
    );
  });

  it("rejects an absent or unknown outcome", () => {
    expect(() => normalizeCloseAccount({})).toThrow(/balance_handling/);
    expect(() =>
      normalizeCloseAccount({ balance_handling: "transfer" }),
    ).toThrow(/balance_handling/);
  });
});

describe("previewAccountPortfolioLots", () => {
  it("returns the complete sorted buy, gift, and sell selection", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5 }] }).mockResolvedValueOnce({
      rows: [
        { id: 2, eligible_count: "3" },
        { id: 7, eligible_count: "3" },
        { id: 9, eligible_count: "3" },
      ],
    });

    await expect(previewAccountPortfolioLots(asAccountId(5))).resolves.toEqual({
      account_id: 5,
      eligible_count: 3,
      transaction_ids: [2, 7, 9],
      limit: 500,
    });
    expect(must(query.mock.calls[1], "query.mock.calls[1]")[1]).toEqual(
      expect.arrayContaining([5, "buy", "gift", "sell", 501]),
    );
  });

  it("withholds a partial ID list when the account exceeds the atomic limit", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 5 }] }).mockResolvedValueOnce({
      rows: [{ id: 1, eligible_count: "501" }],
    });

    await expect(previewAccountPortfolioLots(asAccountId(5))).resolves.toEqual(
      expect.objectContaining({
        eligible_count: 501,
        transaction_ids: [],
        limit: 500,
      }),
    );
  });

  it("rejects a missing account before reading portfolio rows", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(previewAccountPortfolioLots(asAccountId(99))).rejects.toThrow(/not found/i);
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("closeAccount", () => {
  it("preserves the balance and closes without adding a ledger row", async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ id: 5, is_active: true }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await closeAccount(asAccountId(5), { balance_handling: "preserve" });

    expect(withTransaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(2);
    expect(systemRecipient).not.toHaveBeenCalled();
    expect(result.adjustments).toEqual([]);
  });

  it("zeros every non-zero currency partition before closing", async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ id: 5, is_active: true }] })
      .mockResolvedValueOnce({
        rows: [
          {
            balance_parts: [
              { currency: "EUR", balance: "125.505" },
              { currency: "USD", balance: "-20" },
              { currency: "GBP", balance: "0.001" },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 71,
            amount: "-125.51",
            currency: "EUR",
            transfer_source: "adjustment",
          },
          {
            id: 72,
            amount: "20",
            currency: "USD",
            transfer_source: "adjustment",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await closeAccount(asAccountId(5), {
      balance_handling: "adjustment",
    });

    const insertParams = must(query.mock.calls[2], "query.mock.calls[2]")[1];
    expect(insertParams).toEqual(
      expect.arrayContaining([[-125.5, 20], ["EUR", "USD"]]),
    );
    expect(result.adjustments).toHaveLength(2);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("is retry-safe after the account is already closed", async () => {
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 5, is_active: false }],
    });

    const result = await closeAccount(asAccountId(5), {
      balance_handling: "adjustment",
    });

    expect(result.already_closed).toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(systemRecipient).not.toHaveBeenCalled();
  });

  it("fails before mutation when the account does not exist", async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      closeAccount(asAccountId(99), { balance_handling: "adjustment" }),
    ).rejects.toThrow(/not found/i);
    expect(query).toHaveBeenCalledOnce();
  });
});
