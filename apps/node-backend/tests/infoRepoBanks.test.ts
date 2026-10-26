import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockedBatchConvertGroups } from "./helpers/mockCurrencyConversion.ts";
import type { Mock } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";

vi.mock("../src/database/connection.ts", () => mockConnection());

vi.mock("../src/repositories/infoRepositoryHelpers.ts", async () => {
  const actual = await vi.importActual(
    "../src/repositories/infoRepositoryHelpers.ts",
  );
  return { ...actual, batchConvertGroupsWithHistoricalRateFallback: vi.fn() };
});

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { batchConvertGroupsWithHistoricalRateFallback as rawBatchConvertGroupsWithHistoricalRateFallback } from "../src/repositories/infoRepositoryHelpers.ts";
import { banksRepository } from "../src/repositories/infoRepositoryBanks.ts";
import { must } from "./helpers/must.ts";

const query = rawQuery as unknown as Mock<
  (text: string, params?: readonly unknown[]) => Promise<Partial<PgQueryResult>>
>;
const batchConvertGroupsWithHistoricalRateFallback = mockedBatchConvertGroups(
  rawBatchConvertGroupsWithHistoricalRateFallback,
);

beforeEach(() => vi.clearAllMocks());

/**
 * A current-balance row as pg returns it: BIGINT counts as text, DATE
 * first/last transaction as local-midnight Dates, `date` through to_char.
 */
function balanceRow(overrides: Record<string, unknown> = {}) {
  const bankAccountOverride = overrides.bank_account;
  const bankAccount =
    typeof bankAccountOverride === "string" ? bankAccountOverride : "A";
  return {
    account_id: 1,
    bank_account: bankAccount,
    display_name: bankAccount,
    currency: "EUR",
    balance: "0",
    statement_balances: [],
    account_currency: "EUR",
    anchor_date: null,
    post_anchor_count: null,
    date: "2025-04-15",
    transaction_count: "0",
    first_transaction: null,
    last_transaction: null,
    ...overrides,
  };
}

describe("banksRepository.getBankBalances", () => {
  it("returns empty when no transactions exist", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [],
    ]);
    const r = await banksRepository.getBankBalances();
    expect(r).toEqual({
      accounts: [],
      total_net_position: 0,
      history: {},
      total_history: [],
      unconverted_count: 0,
      unconverted_currencies: [],
    });
  });

  it("builds account list with current balance and total net position", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          balanceRow({
            account_id: 41,
            bank_account: "A",
            currency: "EUR",
            balance: "1000",
            date: "2025-04-15",
            transaction_count: "10",
            first_transaction: new Date(2024, 0, 1),
            last_transaction: new Date(2025, 3, 15),
          }),
          balanceRow({
            account_id: 42,
            bank_account: "B",
            currency: "USD",
            balance: "200",
            date: "2025-04-15",
            transaction_count: "5",
            first_transaction: new Date(2024, 5, 1),
            last_transaction: new Date(2025, 3, 15),
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        {
          account_id: 41,
          bank_account: "A",
          amount_eur: 1000,
          transaction_count: "10",
          first_transaction: "2024-01-01",
          last_transaction: "2025-04-15",
        },
        {
          account_id: 42,
          bank_account: "B",
          amount_eur: 187.5,
          transaction_count: "5",
          first_transaction: "2024-06-01",
          last_transaction: "2025-04-15",
        },
      ],
      [],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.accounts).toHaveLength(2);
    expect(r.accounts[0]).toMatchObject({
      account_id: 41,
      bank_account: "A",
      balance: 1000,
      transaction_count: 10,
    });
    expect(r.accounts[1]).toMatchObject({
      account_id: 42,
      bank_account: "B",
      balance: 187.5,
      transaction_count: 5,
    });
    expect(r.total_net_position).toBe(1187.5);
  });

  it("groups historical balances by bank account, sorted by date asc", async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        {
          bank_account: "A",
          day: "2025-03-14",
          currency: "EUR",
          balance: "900",
        },
        {
          bank_account: "A",
          day: "2025-03-15",
          currency: "EUR",
          balance: "1000",
        },
        {
          bank_account: "B",
          day: "2025-03-15",
          currency: "EUR",
          balance: "500",
        },
      ],
    });

    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [
        { bank_account: "A", day: "2025-03-15", amount_eur: 1000 },
        { bank_account: "A", day: "2025-03-14", amount_eur: 900 },
        { bank_account: "B", day: "2025-03-15", amount_eur: 500 },
      ],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.history.A).toEqual([
      { date: "2025-03-14", balance: 900 },
      { date: "2025-03-15", balance: 1000 },
    ]);
    expect(r.history.B).toEqual([{ date: "2025-03-15", balance: 500 }]);
  });

  it("aggregates total_history by summing balances across all banks per day", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [
        { bank_account: "A", day: "2025-03-15", amount_eur: 1000 },
        { bank_account: "B", day: "2025-03-15", amount_eur: 500 },
        { bank_account: "A", day: "2025-03-14", amount_eur: 900 },
      ],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.total_history).toEqual([
      { date: "2025-03-14", balance: 900 },
      { date: "2025-03-15", balance: 1500 },
    ]);
  });

  it("formats a Date-shaped day defensively as YYYY-MM-DD", async () => {
    // The SQL emits day via to_char so it always arrives as a string; the Date
    // branch is defensive (local getters — not toISOString) for pg-DATE shapes.
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [{ bank_account: "A", day: new Date(2025, 3, 1), amount_eur: 100 }],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(
      must(must(r.history.A, "r.history.A")[0], "r.history.A[0]").date,
    ).toBe("2025-04-01");
  });

  it("drops history rows with a blank bank_account", async () => {
    // accounts.name is NOT NULL, so the defensive filter can only meet "".
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        {
          bank_account: "",
          day: "2025-04-01",
          currency: "EUR",
          balance: "100",
        },
      ],
    });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.history).toEqual({});
  });

  it("carries display_name, native drift and balance provenance per account (WP-A1)", async () => {
    // Three fixture shapes:
    //  (a) manual-only — nothing ever stamped: no anchor_date, count = ALL
    //      active rows, no statement balance so no drift;
    //  (b) stamped + manual rows after the anchor: anchor_date + entries-since
    //      + a native-currency drift (statement 5087.5 − the account's own
    //      EUR partition, 5100) matching the hub badge;
    //  (c) display_name falls back to the account name when unset.
    query
      .mockResolvedValueOnce({
        rows: [
          balanceRow({
            account_id: 1,
            bank_account: "Cash",
            display_name: "Cash",
            currency: "EUR",
            balance: "200",
            statement_balances: [],
            account_currency: "EUR",
            anchor_date: null,
            post_anchor_count: "3",
            transaction_count: "3",
            first_transaction: new Date(2026, 0, 1),
            last_transaction: new Date(2026, 6, 1),
          }),
          balanceRow({
            account_id: 2,
            bank_account: "BE12 3456",
            display_name: "KBC Zichtrekening",
            currency: "EUR",
            balance: "5100",
            // json_build_object encodes the NUMERIC as a JSON number.
            statement_balances: [
              {
                currency: "EUR",
                balance: 5087.5,
                balance_date: "2026-06-30",
              },
            ],
            account_currency: "EUR",
            anchor_date: "2026-06-30",
            post_anchor_count: "2",
            transaction_count: "40",
            first_transaction: new Date(2024, 0, 1),
            last_transaction: new Date(2026, 6, 20),
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        {
          bank_account: "Cash",
          display_name: "Cash",
          currency: "EUR",
          balance: "200",
          amount_eur: 200,
          statement_balances: [],
          account_currency: "EUR",
          anchor_date: null,
          post_anchor_count: "3",
          transaction_count: "3",
          first_transaction: "2026-01-01",
          last_transaction: "2026-07-01",
        },
        {
          bank_account: "BE12 3456",
          display_name: "KBC Zichtrekening",
          currency: "EUR",
          balance: "5100",
          amount_eur: 5100,
          statement_balances: [
            { currency: "EUR", balance: 5087.5, balance_date: "2026-06-30" },
          ],
          account_currency: "EUR",
          anchor_date: "2026-06-30",
          post_anchor_count: "2",
          transaction_count: "40",
          first_transaction: "2024-01-01",
          last_transaction: "2026-07-20",
        },
      ],
      [],
    ]);

    const r = await banksRepository.getBankBalances();

    // (a) manual-only: included with its computed Σ(amount) balance —
    // provenance says "sum of 3 entries" (no anchor). null → undefined
    // (backend never returns null), so JSON omits the absent fields.
    expect(r.accounts[0]).toMatchObject({
      bank_account: "Cash",
      display_name: "Cash",
      balance: 200,
      post_anchor_count: 3,
    });
    expect(must(r.accounts[0], "r.accounts[0]").anchor_date).toBeUndefined();
    expect(must(r.accounts[0], "r.accounts[0]").drift).toBeUndefined();

    // (b) stamped + manual: "as of 2026-06-30 statement + 2 entries since",
    // drift is the hub's native-currency figure, derived per currency from the
    // account's own-currency partition (5087.5 − 5100).
    expect(r.accounts[1]).toMatchObject({
      bank_account: "BE12 3456",
      display_name: "KBC Zichtrekening",
      balance: 5100,
      drift: -12.5,
      anchor_date: "2026-06-30",
      post_anchor_count: 2,
    });

    // Both populate the widget — the old `balance IS NOT NULL` gate that hid
    // stamp-less accounts is gone.
    expect(r.accounts).toHaveLength(2);
    expect(r.total_net_position).toBe(5300);
  });

  it("falls back to the account name when display_name is absent", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          balanceRow({
            bank_account: "Old Row",
            currency: "EUR",
            balance: "10",
            transaction_count: "1",
            first_transaction: new Date(2026, 0, 1),
            last_transaction: new Date(2026, 0, 1),
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        {
          bank_account: "Old Row",
          amount_eur: 10,
          transaction_count: "1",
          first_transaction: "2026-01-01",
          last_transaction: "2026-01-01",
        },
      ],
      [],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(must(r.accounts[0], "r.accounts[0]").display_name).toBe("Old Row");
  });
});
