/**
 * Account Repository tests (ADR-088). Mocks the DB layer and checks the row
 * shaping and balance/drift arithmetic. Filtering, pagination, identity lookup
 * and writes run against PostgreSQL in accountRepositoryBoundary.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { mockCurrencyConversion } from "./helpers/mockCurrencyConversion.ts";
import { mockTxConnection } from "./helpers/repoMocks.ts";
import { accountBalanceRow, accountRow } from "./helpers/pgRows.ts";
import {
  asAccountId,
  asCurrencyCode,
} from "@vision/types/brands";

// Latest stored rates: 1 USD = 0.5 EUR; any other currency has no rate.
const { mockListLatestStoredRates } = vi.hoisted(() => ({
  mockListLatestStoredRates: vi.fn(async () => ({
    rows: [
      {
        currency_code: "USD",
        rate_to_eur: "0.5",
        rate_date: "2026-06-01",
        fetched_at: "2026-06-01T10:00:00Z",
      },
    ],
  })),
}));

vi.mock("../src/database/connection.ts", () => mockTxConnection());
// accountService.list folds the repository's per-currency partitions into
// `accounts.currency` at the latest stored rates. Stub that table so these SQL
// + shaping tests do not reach the database or ECB.
vi.mock("../src/services/currency/currencyConversionService.ts", () =>
  mockCurrencyConversion({ listLatestStoredRates: mockListLatestStoredRates }),
);

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import accountRepository from "../src/repositories/accountRepository.ts";
import { accountService } from "../src/services/accountService.ts";

const query = rawQuery as unknown as Mock<
  (
    text: string,
    params?: readonly unknown[],
  ) => Promise<Partial<PgQueryResult<unknown>>>
>;

const listAccounts = async (
  opts: Parameters<typeof accountService.list>[0] = {},
) => (await accountService.list(opts)).items;

describe("accountRepository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps a canceled funding-graph lock wait to a retryable service error", async () => {
    query.mockRejectedValueOnce(
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014",
      }),
    );

    await expect(
      accountRepository.lockFundingGraphForMutation(),
    ).rejects.toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
  });

  describe("getAll", () => {
    it("returns database rows unchanged for service-layer shaping", async () => {
      const raw = accountBalanceRow({
        id: asAccountId(1),
        balance_parts: [{ currency: asCurrencyCode("USD"), balance: "12.3400" }],
        statement_balances: [],
        anchor_date: null,
      });
      query.mockResolvedValueOnce({ rows: [raw] });
      expect(await accountRepository.getAll()).toEqual([raw]);
    });

    it("lists all accounts without an active filter", async () => {
      query.mockResolvedValueOnce({
        rows: [accountBalanceRow({ id: asAccountId(1), name: "Checking" })],
      });
      const rows = await listAccounts();
      // No partitions at all (an account with no active rows) → a 0 balance and
      // no drift, with the provenance fields absent rather than null.
      expect(rows).toEqual([
        {
          ...accountRow({ id: asAccountId(1), name: "Checking" }),
          has_transactions: false,
          computed_balance: 0,
          balance_parts: [],
          balance_incomplete: false,
          unconverted_currencies: [],
          reconcilable_balance: 0,
          reconcilable_currency: "EUR",
          drift: null,
          statement_balances: [],
          anchor_date: undefined,
          post_anchor_count: undefined,
        },
      ]);
    });

    // The defect this replaced: SUM(t2.amount) added a EUR amount to a USD
    // amount as bare numbers, and the caller converted that total at the single
    // rate of the most recent row's currency — 100 EUR + 100 USD at 0.5 came out
    // as 100 instead of 150.
    it("sums the currency partitions into the account currency, not across them", async () => {
      query.mockResolvedValueOnce({
        rows: [
          accountBalanceRow({
            id: asAccountId(1),
            name: "Wise",
            currency: asCurrencyCode("EUR"),
            statement_balances: [],
            balance_parts: [
              { currency: asCurrencyCode("EUR"), balance: "100.0000" },
              { currency: asCurrencyCode("USD"), balance: "100.0000" },
            ],
          }),
        ],
      });
      const row = (await listAccounts())[0]!;
      expect(row.computed_balance).toBe(150); // 100 EUR + 100 USD × 0.5
      expect(row.balance_parts).toEqual([
        { currency: "EUR", balance: 100 },
        { currency: "USD", balance: 100 },
      ]);
      expect(row.balance_incomplete).toBe(false);
      expect(row.unconverted_currencies).toEqual([]);
    });

    // Drift is the statement figure against the partition it is a statement FOR
    // (the account's own currency), never against the FX-converted total — which
    // would make a reconciliation figure move with the daily rate.
    it("derives drift from the account-currency partition on a multi-currency account", async () => {
      query.mockResolvedValueOnce({
        rows: [
          accountBalanceRow({
            id: asAccountId(1),
            name: "Wise",
            currency: asCurrencyCode("EUR"),
            statement_balances: [
              {
                currency: asCurrencyCode("EUR"),
                balance: 120,
                balance_date: "2026-07-01",
              },
            ],
            balance_parts: [
              { currency: asCurrencyCode("EUR"), balance: "100.0000" },
              { currency: asCurrencyCode("USD"), balance: "100.0000" },
            ],
          }),
        ],
      });
      const row = (await listAccounts())[0]!;
      expect(row.computed_balance).toBe(150);
      expect(row.drift).toBe(20); // 120 − the EUR partition's 100, NOT 120 − 150
      // …and the base behind that subtraction is emitted, so the reconcile
      // dialog can preview an entered reading against the SAME figure the
      // server will resolve against instead of against computed_balance.
      expect(row.reconcilable_balance).toBe(100);
      expect(row.reconcilable_currency).toBe("EUR");
      expect(row.drift).toBe(
        row.statement_balances[0]!.balance - row.reconcilable_balance,
      );
    });

    it("excludes a partition with no rate and exposes the native balance", async () => {
      query.mockResolvedValueOnce({
        rows: [
          accountBalanceRow({
            id: asAccountId(1),
            name: "Unsupported currency",
            currency: asCurrencyCode("EUR"),
            balance_parts: [
              { currency: asCurrencyCode("EUR"), balance: "100.0000" },
              { currency: asCurrencyCode("ZZZ"), balance: "40.0000" },
            ],
          }),
        ],
      });
      const row = (await listAccounts())[0]!;
      expect(row.computed_balance).toBe(100);
      expect(row.balance_incomplete).toBe(true);
      expect(row.unconverted_currencies).toEqual(["ZZZ"]);
      expect(row.balance_parts).toContainEqual({
        currency: "ZZZ",
        balance: 40,
      });
    });

    it("holds drift = statement − reconcilable_balance even on a sub-cent partition tail", async () => {
      query.mockResolvedValueOnce({
        rows: [
          accountBalanceRow({
            id: asAccountId(1),
            name: "Wise",
            currency: asCurrencyCode("EUR"),
            statement_balances: [
              {
                currency: asCurrencyCode("EUR"),
                balance: 100.01,
                balance_date: "2026-07-01",
              },
            ],
            balance_parts: [
              // NUMERIC(18,4) sums can carry a 4-dp tail; the wire rounds the
              // base to cents, and drift must be differenced against the SAME
              // rounded figure or the on-screen identity breaks by a cent.
              { currency: asCurrencyCode("EUR"), balance: "100.0150" },
              { currency: asCurrencyCode("USD"), balance: "50.0000" },
            ],
          }),
        ],
      });
      const row = (await listAccounts())[0]!;
      expect(row.reconcilable_balance).toBe(100.02);
      expect(row.drift).toBe(-0.01);
      expect(row.drift).toBeCloseTo(
        row.statement_balances[0]!.balance - row.reconcilable_balance,
        10,
      );
    });

    // Every consumer of the three native figures relies on this identity.
    it("emits reconcilable_balance == computed_balance on a single-currency account", async () => {
      query.mockResolvedValueOnce({
        rows: [
          accountBalanceRow({
            id: asAccountId(1),
            name: "KBC",
            currency: asCurrencyCode("EUR"),
            statement_balances: [
              { currency: asCurrencyCode("EUR"), balance: 90, balance_date: "2026-07-01" },
            ],
            balance_parts: [{ currency: asCurrencyCode("EUR"), balance: "100.0000" }],
          }),
        ],
      });
      const row = (await listAccounts())[0]!;
      expect(row.computed_balance).toBe(100);
      expect(row.reconcilable_balance).toBe(100);
      expect(row.reconcilable_currency).toBe("EUR");
      expect(row.drift).toBe(-10);
    });

    // D4: the statement names a currency the account holds nothing in. The base
    // is 0 and 'accept' will write 0 — surfacing the base is what makes that
    // outcome visible in the dialog instead of arriving unannounced.
    it("emits a zero base when no partition matches the account currency", async () => {
      query.mockResolvedValueOnce({
        rows: [
          accountBalanceRow({
            id: asAccountId(1),
            name: "GBP shell",
            currency: asCurrencyCode("GBP"),
            statement_balances: [
              { currency: asCurrencyCode("GBP"), balance: 50, balance_date: "2026-07-01" },
            ],
            balance_parts: [
              { currency: asCurrencyCode("EUR"), balance: "100.0000" },
              { currency: asCurrencyCode("USD"), balance: "100.0000" },
            ],
          }),
        ],
      });
      const row = (await listAccounts())[0]!;
      expect(row.reconcilable_balance).toBe(0);
      expect(row.reconcilable_currency).toBe("GBP");
      expect(row.drift).toBe(50);
    });

    // The mislabelled single-currency account: one partition reconciles against
    // the statement whatever its code, so nothing regresses for the common case.
    it("reconciles a lone partition even when its currency differs from the account", async () => {
      query.mockResolvedValueOnce({
        rows: [
          accountBalanceRow({
            id: asAccountId(1),
            name: "Wise USD",
            currency: asCurrencyCode("EUR"),
            statement_balances: [
              { currency: asCurrencyCode("USD"), balance: 90, balance_date: "2026-07-01" },
            ],
            balance_parts: [{ currency: asCurrencyCode("USD"), balance: "100.0000" }],
          }),
        ],
      });
      const row = (await listAccounts())[0]!;
      expect(row.computed_balance).toBe(50); // 100 USD × 0.5, into the account's EUR
      expect(row.drift).toBe(-10); // native: 90 − the sole partition's 100
      // D3: the base carries the partition's OWN code, so the dialog can label
      // the statement/base/difference triple honestly (all USD) beside the
      // converted computed_balance instead of printing a USD drift as EUR.
      expect(row.reconcilable_balance).toBe(100);
      expect(row.reconcilable_currency).toBe("USD");
    });

    // D2: a cancelled/offsetting foreign transfer pair nets to zero but still
    // creates a partition. It must not move the reconciliation base.
    it("ignores a zero-sum partition when resolving the base", async () => {
      query.mockResolvedValueOnce({
        rows: [
          accountBalanceRow({
            id: asAccountId(1),
            name: "Noisy",
            currency: asCurrencyCode("EUR"),
            statement_balances: [
              {
                currency: asCurrencyCode("USD"),
                balance: 100,
                balance_date: "2026-07-01",
              },
            ],
            balance_parts: [
              { currency: asCurrencyCode("GBP"), balance: "0.0000" }, // offsetting pair, net 0
              { currency: asCurrencyCode("USD"), balance: "100.0000" },
            ],
          }),
        ],
      });
      const row = (await listAccounts())[0]!;
      expect(row.reconcilable_balance).toBe(100); // the USD partition, as if the noise were absent
      expect(row.reconcilable_currency).toBe("USD");
      expect(row.drift).toBe(0); // was 100 — the whole balance — before the noise was dropped
    });

    it("shapes provenance: NULL anchor_date → undefined, bigint-string count → number", async () => {
      query.mockResolvedValueOnce({
        rows: [
          // (a) stamped anchor + entries since — count arrives as a pg bigint string
          accountBalanceRow({
            id: asAccountId(1),
            name: "KBC",
            anchor_date: "2026-06-30",
            post_anchor_count: "2",
          }),
          // (b) nothing stamped — SQL NULL anchor, count = all active rows
          accountBalanceRow({
            id: asAccountId(2),
            name: "Cash",
            anchor_date: null,
            post_anchor_count: "3",
          }),
        ],
      });
      const rows = await listAccounts();
      expect(rows[0]!.anchor_date).toBe("2026-06-30");
      expect(rows[0]!.post_anchor_count).toBe(2);
      // Backend never returns null — SQL NULL maps to undefined at the boundary.
      expect(rows[1]!.anchor_date).toBeUndefined();
      expect(rows[1]!.post_anchor_count).toBe(3);
    });
  });

  describe("getById / getByName", () => {
    it("returns undefined when not found", async () => {
      query.mockResolvedValueOnce({ rows: [] });
      expect(await accountRepository.getById(asAccountId(99))).toBeUndefined();
    });
  });

  describe("update", () => {
    it("returns undefined when the update affects no row", async () => {
      query.mockResolvedValueOnce({ rows: [] });
      expect(
        await accountRepository.update(asAccountId(1), { currency: "USD" }),
      ).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("returns the deleted id", async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 8 }] });
      expect(await accountRepository.remove(asAccountId(8))).toBe(8);
    });

    it("returns undefined when nothing was deleted", async () => {
      query.mockResolvedValueOnce({ rows: [] });
      expect(await accountRepository.remove(asAccountId(8))).toBeUndefined();
    });
  });
});
