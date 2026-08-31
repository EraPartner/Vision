import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/database/connection.js", () => ({
  query: vi.fn(),
}));

vi.mock("../src/services/currency/currencyConversionService.js", () => ({
  convertRowsToEur: vi.fn(),
}));

import { query } from "../src/database/connection.js";
import { convertRowsToEur } from "../src/services/currency/currencyConversionService.js";
import { recipientInsightsRepository } from "../src/repositories/infoRepositoryRecipients.js";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("recipientInsightsRepository.getRecipientInsights", () => {
  it("aggregates by recipient and merges currencies via FX conversion", async () => {
    // First call: top spenders raw query.
    query.mockResolvedValueOnce({
      rows: [
        {
          recipient_id: 1,
          recipient_name: "Alice",
          currency: "EUR",
          total_abs_amount: "100",
          tx_count: "4",
          first_seen: "2025-01-01",
          last_seen: "2025-03-15",
        },
        {
          recipient_id: 1,
          recipient_name: "Alice",
          currency: "USD",
          total_abs_amount: "50",
          tx_count: "1",
          first_seen: "2025-04-01",
          last_seen: "2025-04-01",
        },
        {
          recipient_id: 2,
          recipient_name: "Bob",
          currency: "EUR",
          total_abs_amount: "40",
          tx_count: "2",
          first_seen: "2025-02-01",
          last_seen: "2025-02-15",
        },
      ],
    });
    // Second call: month-over-month raw query.
    query.mockResolvedValueOnce({ rows: [] });
    // Third call: current/previous month keys derived in-DB.
    query.mockResolvedValueOnce({
      rows: [{ current_period: "2025-04", prev_period: "2025-03" }],
    });

    convertRowsToEur
      .mockResolvedValueOnce([
        {
          recipient_id: 1,
          recipient_name: "Alice",
          amount_eur: 100,
          tx_count: "4",
          first_seen: "2025-01-01",
          last_seen: "2025-03-15",
        },
        {
          recipient_id: 1,
          recipient_name: "Alice",
          amount_eur: 47,
          tx_count: "1",
          first_seen: "2025-04-01",
          last_seen: "2025-04-01",
        },
        {
          recipient_id: 2,
          recipient_name: "Bob",
          amount_eur: 40,
          tx_count: "2",
          first_seen: "2025-02-01",
          last_seen: "2025-02-15",
        },
      ])
      .mockResolvedValueOnce([]);

    const result =
      await recipientInsightsRepository.getRecipientInsights("EUR");

    expect(result.topMerchants).toHaveLength(2);
    expect(result.topMerchants[0]).toMatchObject({
      recipientId: 1,
      name: "Alice",
      totalSpend: 147,
      transactionCount: 5,
      avgAmount: 29.4,
      firstSeen: "2025-01-01",
      lastSeen: "2025-04-01",
    });
    expect(result.topMerchants[1]).toMatchObject({
      recipientId: 2,
      name: "Bob",
      totalSpend: 40,
      transactionCount: 2,
      avgAmount: 20,
    });
    expect(result.monthOverMonth).toEqual([]);
  });

  it("emits month-over-month entries for recipients with both periods", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({
      rows: [{ current_period: "2025-04", prev_period: "2025-03" }],
    });

    convertRowsToEur.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        recipient_id: 1,
        recipient_name: "Alice",
        period: "2025-04",
        amount_eur: 60,
      },
      {
        recipient_id: 1,
        recipient_name: "Alice",
        period: "2025-03",
        amount_eur: 40,
      },
      {
        recipient_id: 2,
        recipient_name: "Bob",
        period: "2025-04",
        amount_eur: 30,
      },
      // Bob has no previous-month → excluded from MoM list.
    ]);

    const r = await recipientInsightsRepository.getRecipientInsights("EUR");
    expect(r.monthOverMonth).toEqual([
      {
        recipientId: 1,
        name: "Alice",
        currentSpend: 60,
        previousSpend: 40,
        changePercent: 50,
      },
    ]);
    // The MoM query (2nd call) must window the previous month to the same
    // day-of-month so a partial current month isn't compared to a full prior one.
    const momSql = query.mock.calls[1][0];
    expect(momSql).toContain(
      "(CURRENT_DATE - DATE_TRUNC('month', CURRENT_DATE)::date)",
    );
    // MoM converts at HISTORICAL per-date rates like every other recipient
    // surface — the no-DB guard for the fix that ended latest-rate conversion
    // here (the DB pin proves the numbers; this pins the contract).
    expect(momSql).toContain("t.date");
    expect(convertRowsToEur).toHaveBeenNthCalledWith(
      2,
      expect.any(Array),
      "EUR",
      {
        useHistoricalRatesByDate: true,
        dateField: "date",
      },
    );
  });

  it("caps month-over-month list to top-10 by current spend", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({
      rows: [{ current_period: "2025-04", prev_period: "2025-03" }],
    });

    convertRowsToEur.mockResolvedValueOnce([]).mockResolvedValueOnce(
      Array.from({ length: 15 }, (_, i) => [
        {
          recipient_id: i + 1,
          recipient_name: `R${i}`,
          period: "2025-04",
          amount_eur: 100 - i,
        },
        {
          recipient_id: i + 1,
          recipient_name: `R${i}`,
          period: "2025-03",
          amount_eur: 50,
        },
      ]).flat(),
    );

    const r = await recipientInsightsRepository.getRecipientInsights("EUR");
    expect(r.monthOverMonth).toHaveLength(10);
    expect(r.monthOverMonth[0].currentSpend).toBe(100);
  });

  it("applies the canonical 3-level category exclusion to both queries", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({
      rows: [{ current_period: "2025-04", prev_period: "2025-03" }],
    });
    convertRowsToEur.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await recipientInsightsRepository.getRecipientInsights("EUR", {
      excludedCategoryIds: [5, 7],
    });

    const [topSql, topParams] = query.mock.calls[0];
    const [momSql] = query.mock.calls[1];
    for (const sql of [topSql, momSql]) {
      expect(sql).toContain(
        "COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN",
      );
    }
    expect(topParams).toEqual([5, 7]);
  });
});

describe("recipientInsightsRepository.getRecipientByYear", () => {
  it("groups by year and recipient with absolute EUR sums", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    // cnt is the grouped row's transaction count (SQL now aggregates per group).
    convertRowsToEur.mockResolvedValueOnce([
      { year: 2024, recipient_id: 1, name: "Alice", amount_eur: -100, cnt: 1 },
      { year: 2024, recipient_id: 1, name: "Alice", amount_eur: -25, cnt: 1 },
      { year: 2024, recipient_id: 2, name: "Bob", amount_eur: -50, cnt: 1 },
      { year: 2025, recipient_id: 1, name: "Alice", amount_eur: -10, cnt: 1 },
    ]);

    const r = await recipientInsightsRepository.getRecipientByYear({
      targetCurrency: "EUR",
    });
    expect(r.recipientsByYear["2024"]).toEqual([
      { recipientId: 1, name: "Alice", totalSpend: 125, transactionCount: 2 },
      { recipientId: 2, name: "Bob", totalSpend: 50, transactionCount: 1 },
    ]);
    expect(r.recipientsByYear["2025"]).toHaveLength(1);
  });

  it("limits each year to top 20 recipients by spend", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce(
      Array.from({ length: 25 }, (_, i) => ({
        year: 2025,
        recipient_id: i + 1,
        name: `R${i}`,
        amount_eur: -(100 - i),
      })),
    );
    const r = await recipientInsightsRepository.getRecipientByYear({
      targetCurrency: "EUR",
    });
    expect(r.recipientsByYear["2025"]).toHaveLength(20);
    expect(r.recipientsByYear["2025"][0].totalSpend).toBe(100);
  });

  // Was: asserted to bind as [7, 99] — the excluded recipients silently came
  // back into the result. See the note in filterBuilder.test.js.
  it("rejects malformed recipient exclusion ids instead of dropping them", async () => {
    await expect(
      recipientInsightsRepository.getRecipientByYear({
        targetCurrency: "EUR",
        excludedRecipientIds: [0, -1, 2147483647, 1.5, "string", 7, 99],
      }),
    ).rejects.toThrow(/excludedRecipientIds contains invalid value/);

    expect(query).not.toHaveBeenCalled();
  });

  it("binds a recipient exclusion id at the int4 ceiling instead of dropping it", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await recipientInsightsRepository.getRecipientByYear({
      targetCurrency: "EUR",
      excludedRecipientIds: [2147483647, 7],
    });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([2147483647, 7]);
  });

  it("omits the NOT IN clause when no valid ids", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await recipientInsightsRepository.getRecipientByYear({
      targetCurrency: "EUR",
    });
    const [sql] = query.mock.calls[0];
    expect(sql).not.toContain("NOT IN");
  });

  it("applies category exclusions (3-level alias-aware COALESCE) when provided", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await recipientInsightsRepository.getRecipientByYear({
      targetCurrency: "EUR",
      excludedCategoryIds: [5, 7],
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain(
      "COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN",
    );
    expect(params).toEqual([5, 7]);
  });
});

describe("recipientInsightsRepository.getRecipientPivot", () => {
  it("uses monthly bucket by default (TO_CHAR YYYY-MM)", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await recipientInsightsRepository.getRecipientPivot({
      targetCurrency: "EUR",
    });
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("TO_CHAR(t.date, 'YYYY-MM')");
  });

  it("uses yearly bucket when requested", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await recipientInsightsRepository.getRecipientPivot({
      targetCurrency: "EUR",
      bucket: "yearly",
    });
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("TO_CHAR(t.date, 'YYYY')");
  });

  it("narrows the scan to the selected recipients (alias-resolved) when recipientIds given", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 5 }, { id: 9 }, { id: 9 }] }) // alias-member resolution
      .mockResolvedValueOnce({ rows: [] }); // pivot
    convertRowsToEur.mockResolvedValueOnce([]);

    await recipientInsightsRepository.getRecipientPivot({
      targetCurrency: "EUR",
      recipientIds: [5],
    });

    // First query resolves selections to canonical roots, then expands every
    // root to all members. UNION and the defensive Set avoid overlap when a
    // saved chart contains both a primary and one of its aliases.
    expect(query.mock.calls[0][0]).toContain(
      "SELECT DISTINCT COALESCE(primary_recipient_id, id) AS id",
    );
    expect(query.mock.calls[0][0]).toContain(
      "JOIN selected_roots sr ON r.primary_recipient_id = sr.id",
    );
    expect(query.mock.calls[0][0]).toContain("UNION");
    expect(query.mock.calls[0][1]).toEqual([[5]]);
    // …then the pivot scans only those recipients' rows (index-friendly).
    expect(query.mock.calls[1][0]).toContain("t.recipient_id = ANY");
    expect(query.mock.calls[1][1]).toContainEqual([5, 9]);
    expect(query.mock.calls[1][1]).not.toContainEqual([5, 9, 9]);
  });

  it("short-circuits when every selected recipient id is unknown", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      recipientInsightsRepository.getRecipientPivot({
        targetCurrency: "EUR",
        recipientIds: [2147483646],
      }),
    ).resolves.toEqual({ recipientPivot: {} });

    expect(query).toHaveBeenCalledTimes(1);
    expect(convertRowsToEur).not.toHaveBeenCalled();
  });

  it("rejects malformed recipient selections before querying", async () => {
    await expect(
      recipientInsightsRepository.getRecipientPivot({
        targetCurrency: "EUR",
        recipientIds: [5, "evil"],
      }),
    ).rejects.toThrow(/recipientIds contains invalid value/);

    expect(query).not.toHaveBeenCalled();
  });

  it("retains a selected recipient at the int4 ceiling", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 2147483647 }] });
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await recipientInsightsRepository.getRecipientPivot({
      targetCurrency: "EUR",
      recipientIds: [2147483647],
    });

    expect(query.mock.calls[0][1]).toEqual([[2147483647]]);
  });

  it("applies start and end date filters", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await recipientInsightsRepository.getRecipientPivot({
      targetCurrency: "EUR",
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/t\.date >= \$\d+/);
    expect(sql).toMatch(/t\.date <= \$\d+/);
    expect(params).toContain("2025-01-01");
    expect(params).toContain("2025-12-31");
  });

  it("groups by period+recipient and sorts ascending by total", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([
      {
        period: "2025-04",
        recipient_id: 1,
        recipient_name: "A",
        amount_eur: -100,
        cnt: 1,
      },
      {
        period: "2025-04",
        recipient_id: 2,
        recipient_name: "B",
        amount_eur: -50,
        cnt: 1,
      },
      {
        period: "2025-04",
        recipient_id: 1,
        recipient_name: "A",
        amount_eur: -25,
        cnt: 1,
      },
    ]);

    const r = await recipientInsightsRepository.getRecipientPivot({
      targetCurrency: "EUR",
    });
    expect(r.recipientPivot["2025-04"]).toEqual([
      { recipientId: 2, name: "B", total: 50, transactionCount: 1 },
      { recipientId: 1, name: "A", total: 125, transactionCount: 2 },
    ]);
  });

  it("combines exclusion ids and date filter param numbering", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await recipientInsightsRepository.getRecipientPivot({
      excludedRecipientIds: [5, 6],
      targetCurrency: "EUR",
      startDate: "2025-01-01",
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("NOT IN ($1, $2)");
    expect(sql).toContain("t.date >= $3");
    expect(params).toEqual([5, 6, "2025-01-01"]);
  });
});
