import { describe, it, expect, vi, beforeEach } from "vitest";

import { mockLogger } from "./helpers/mockLogger.js";
import { mockTxConnection } from "./helpers/repoMocks.js";
const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }));
vi.mock("../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

// Transaction shim: runs the callback; a throw propagates (= rollback).
vi.mock("../src/database/connection.js", () => mockTxConnection(mockClient));

vi.mock("../src/repositories/portfolioTransactionRepository.js", () => ({
  default: { create: vi.fn(), hardDelete: vi.fn() },
}));

vi.mock("../src/repositories/recipientRepository.js", () => ({
  default: { createOrGet: vi.fn(), getOrCreateSystemId: vi.fn() },
}));

vi.mock("../src/repositories/categoryRepository.js", () => ({
  default: { createOrGet: vi.fn() },
}));

vi.mock("../src/services/portfolio/fxResolve.js", () => ({
  autoResolveFxRateToEur: vi.fn(),
}));

import { query, poolQuery } from "../src/database/connection.js";
import portfolioTransactionRepository from "../src/repositories/portfolioTransactionRepository.js";
import recipientRepository from "../src/repositories/recipientRepository.js";
import categoryRepository from "../src/repositories/categoryRepository.js";
import { autoResolveFxRateToEur } from "../src/services/portfolio/fxResolve.js";
import { commitBatch } from "../src/services/portfolioImportPipeline/commit.js";

let matchedRows;
let fieldDuplicate;
let marked;
let batchAccountId;
let isBrokerage;
let cashDuplicate;
let accountInstitution;
let accountName;

function dispatch(sql, params) {
  if (/SELECT b\.account_id, b\.is_brokerage/.test(sql)) {
    return {
      rows: [
        {
          account_id: batchAccountId,
          is_brokerage: isBrokerage,
          account_institution: accountInstitution,
          account_name: accountName,
        },
      ],
    };
  }
  if (/FROM portfolio_import_staging_rows isr/.test(sql))
    return { rows: matchedRows };
  if (/FROM portfolio_transactions\s+WHERE investment_id/.test(sql)) {
    return { rows: [{ n: Number(fieldDuplicate) || 0 }] };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM transactions/.test(sql)) {
    return { rows: [{ n: Number(cashDuplicate) || 0 }] };
  }
  if (/INSERT INTO transactions/.test(sql)) return { rows: [{ id: 777 }] };
  if (/SET status = \$2, error_message/.test(sql)) {
    marked.push({ id: params[0], status: params[1], message: params[2] });
    return { rows: [] };
  }
  return { rows: [] };
}

function row(overrides = {}) {
  return {
    id: 1,
    status: "matched",
    tx_date: "2026-01-05",
    type: "buy",
    units: 10,
    price_per_unit: 185.5,
    amount: 1855,
    fees: 0,
    taxes: 0,
    currency: "EUR",
    fx_rate_to_eur: null,
    note: null,
    tx_hash: "h1",
    investment_id: 1,
    asset_class: "stock",
    investment_currency: "EUR",
    ...overrides,
  };
}

beforeEach(() => {
  matchedRows = [];
  fieldDuplicate = false;
  marked = [];
  batchAccountId = null;
  isBrokerage = false;
  cashDuplicate = false;
  accountInstitution = "IBKR";
  accountName = "IBKR SLEEVE";
  query.mockClear();
  poolQuery.mockReset();
  poolQuery.mockImplementation((sql, params) =>
    Promise.resolve(dispatch(sql, params)),
  );
  mockClient.query.mockReset();
  mockClient.query.mockImplementation((sql, params) =>
    Promise.resolve(dispatch(sql, params)),
  );
  portfolioTransactionRepository.create.mockReset();
  portfolioTransactionRepository.create.mockResolvedValue({ id: 100 });
  recipientRepository.createOrGet.mockReset();
  recipientRepository.createOrGet.mockResolvedValue({
    recipient: { id: 42 },
    created: false,
  });
  recipientRepository.getOrCreateSystemId.mockReset();
  recipientRepository.getOrCreateSystemId.mockResolvedValue(99);
  categoryRepository.createOrGet.mockReset();
  categoryRepository.createOrGet.mockResolvedValue({
    category: { id: 314, is_active: true },
    created: false,
  });
  autoResolveFxRateToEur.mockReset();
  autoResolveFxRateToEur.mockResolvedValue(undefined);
});

describe("commitBatch (portfolio)", () => {
  it("commits a matched row via the repo", async () => {
    matchedRows = [row()];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, duplicates: 0, errors: 0 });
    expect(portfolioTransactionRepository.create).toHaveBeenCalledTimes(1);
    expect(
      portfolioTransactionRepository.create.mock.calls[0][0],
    ).toMatchObject({
      investment_id: 1,
      type: "buy",
      units: 10,
      price_per_unit: 185.5,
      amount: 1855,
      preloaded_asset_class: "stock",
    });
    const committedRow = query.mock.calls.find(([sql]) =>
      /SET status = 'committed'/.test(sql),
    );
    expect(committedRow[1]).toEqual([1, 100]);
    const checkpoint = query.mock.calls.find(([sql]) =>
      /SET rows_imported = COALESCE/.test(sql),
    );
    expect(checkpoint[1]).toEqual([5, 1, 0, 0]);
  });

  it("records a per-row error on oversell without aborting the batch", async () => {
    matchedRows = [row({ id: 1, type: "sell" }), row({ id: 2, tx_hash: "h2" })];
    portfolioTransactionRepository.create
      .mockRejectedValueOnce(
        Object.assign(new Error("sell units exceed available holdings"), {
          code: "VALIDATION_ERROR",
        }),
      )
      .mockResolvedValueOnce({ id: 101 });

    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, errors: 1 });
    expect(marked).toContainEqual(
      expect.objectContaining({
        id: 1,
        status: "error",
        message: expect.stringMatching(/exceed/),
      }),
    );
  });

  it("flags an unresolved instrument as an error and never calls create", async () => {
    matchedRows = [row({ investment_id: null, asset_class: null })];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 0, errors: 1 });
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
    expect(marked[0]).toMatchObject({
      status: "error",
      message: expect.stringMatching(/unresolved/),
    });
  });

  it("auto-resolves FX for a non-EUR row with no supplied rate", async () => {
    matchedRows = [row({ currency: "USD", fx_rate_to_eur: null })];
    autoResolveFxRateToEur.mockResolvedValue(0.92);
    await commitBatch({ batchId: 5 });
    expect(autoResolveFxRateToEur).toHaveBeenCalledWith("USD", "2026-01-05");
    expect(
      portfolioTransactionRepository.create.mock.calls[0][0].fx_rate_to_eur,
    ).toBe(0.92);
  });

  it("does not re-resolve FX when the row already carries a rate", async () => {
    matchedRows = [row({ currency: "USD", fx_rate_to_eur: 0.9 })];
    await commitBatch({ batchId: 5 });
    expect(autoResolveFxRateToEur).not.toHaveBeenCalled();
    expect(
      portfolioTransactionRepository.create.mock.calls[0][0].fx_rate_to_eur,
    ).toBe(0.9);
  });

  it("skips a field-level duplicate already in portfolio_transactions", async () => {
    matchedRows = [row()];
    fieldDuplicate = true;
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 0, duplicates: 1 });
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
  });

  it("preserves two identical same-hash fills on their first import", async () => {
    matchedRows = [row({ id: 1 }), row({ id: 2 })];

    const res = await commitBatch({ batchId: 5 });

    expect(res).toMatchObject({ imported: 2, duplicates: 0, errors: 0 });
    expect(portfolioTransactionRepository.create).toHaveBeenCalledTimes(2);
  });

  it("pairs repeated fills one-for-one with existing destination rows", async () => {
    fieldDuplicate = 1;
    matchedRows = [row({ id: 1 }), row({ id: 2 })];

    const res = await commitBatch({ batchId: 5 });

    expect(res).toMatchObject({ imported: 1, duplicates: 1, errors: 0 });
    expect(portfolioTransactionRepository.create).toHaveBeenCalledTimes(1);
  });

  it("makes a repeated-fill reimport a complete no-op", async () => {
    fieldDuplicate = 2;
    matchedRows = [row({ id: 1 }), row({ id: 2 })];

    const res = await commitBatch({ batchId: 5 });

    expect(res).toMatchObject({ imported: 0, duplicates: 2, errors: 0 });
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
  });

  it("resumes repeated fills after an earlier chunk was committed", async () => {
    fieldDuplicate = 1;
    matchedRows = [
      row({ id: 1, status: "committed" }),
      row({ id: 2, status: "matched" }),
    ];

    const res = await commitBatch({ batchId: 5 });

    expect(res).toMatchObject({ imported: 1, duplicates: 0, errors: 0 });
    expect(portfolioTransactionRepository.create).toHaveBeenCalledTimes(1);
  });

  it("dedups amount-plus-price rows against repository-derived units", async () => {
    fieldDuplicate = 1;
    matchedRows = [row({ units: null, amount: 100, price_per_unit: 25 })];

    const res = await commitBatch({ batchId: 5 });

    expect(res).toMatchObject({ imported: 0, duplicates: 1 });
    const dedupCall = query.mock.calls.find(([sql]) =>
      /FROM portfolio_transactions\s+WHERE investment_id/.test(sql),
    );
    expect(dedupCall[1].slice(3, 5)).toEqual([100, 4]);
  });

  it("dedups units-plus-price rows against repository-derived amount", async () => {
    fieldDuplicate = 1;
    matchedRows = [row({ units: 4, amount: null, price_per_unit: 25 })];

    const res = await commitBatch({ batchId: 5 });

    expect(res).toMatchObject({ imported: 0, duplicates: 1 });
    const dedupCall = query.mock.calls.find(([sql]) =>
      /FROM portfolio_transactions\s+WHERE investment_id/.test(sql),
    );
    expect(dedupCall[1].slice(3, 5)).toEqual([100, 4]);
  });

  it("field-dedup predicate matches on account_id and currency, not just trade shape", async () => {
    batchAccountId = 7;
    matchedRows = [row({ currency: "USD", fx_rate_to_eur: 0.9 })];
    await commitBatch({ batchId: 5 });
    const dedupCall = query.mock.calls.find(([sql]) =>
      /FROM portfolio_transactions\s+WHERE investment_id/.test(sql),
    );
    expect(dedupCall[0]).toContain("account_id IS NOT DISTINCT FROM");
    // [investment_id, tx_date, type, amount, units, account_id, currency]
    expect(dedupCall[1].slice(5)).toEqual([7, "USD"]);
  });

  it("stamps the batch-level account_id onto every committed lot (ADR-095)", async () => {
    batchAccountId = 7;
    matchedRows = [row()];
    await commitBatch({ batchId: 5 });
    expect(
      portfolioTransactionRepository.create.mock.calls[0][0].account_id,
    ).toBe(7);
  });

  it("leaves account_id undefined when the batch has no account", async () => {
    batchAccountId = null;
    matchedRows = [row()];
    await commitBatch({ batchId: 5 });
    expect(
      portfolioTransactionRepository.create.mock.calls[0][0].account_id,
    ).toBeUndefined();
  });

  it("does not collapse legitimate repeated fills by staging tx_hash", async () => {
    matchedRows = [
      row({ id: 1, tx_hash: "dup" }),
      row({ id: 2, tx_hash: "dup" }),
    ];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 2, duplicates: 0 });
  });

  // ── Brokerage fan-out (ADR-095) ─────────────────────────────────────────────
  it("brokerage trade row: creates the lot only — no cash row, no synthetic leg (ADR-108)", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [row({ route: "portfolio", type: "buy", type_raw: "buy" })];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1 });
    expect(portfolioTransactionRepository.create).toHaveBeenCalledTimes(1);
    // No cash INSERT for the trade: imported statements carry the true cash
    // movements as their own rows (synthetic ADR-090 legs are deleted).
    const cashInserts = query.mock.calls.filter(([s]) =>
      /INSERT INTO transactions/.test(s),
    );
    expect(cashInserts).toHaveLength(0);
  });

  it("brokerage cash row: inserts a cash transaction, no trade", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "deposit",
        investment_id: null,
        amount: 1000,
        note: "wire",
      }),
    ];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1 });
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
    const cashInserts = query.mock.calls.filter(([s]) =>
      /INSERT INTO transactions/.test(s),
    );
    expect(cashInserts).toHaveLength(1);
  });

  // ── Cash-row recipient (NOT NULL since 0001; this insert omitted it and every
  // cash row died with 23502 — the bug was invisible to mocks that only check
  // "no error", so these tests pin the actual column list and parameters). ──
  it("cash INSERT carries recipient_id in its column list and params (pinned SQL)", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "deposit",
        investment_id: null,
        amount: 1000,
        note: "wire",
      }),
    ];
    await commitBatch({ batchId: 5 });

    const [sql, params] = query.mock.calls.find(([s]) =>
      /INSERT INTO transactions/.test(s),
    );
    // Exact column list — a regression that drops recipient_id (or reorders it
    // away from its parameter) must fail here, not only on a real database.
    expect(sql).toMatch(
      /INSERT INTO transactions \(date, amount, currency, memo, account_id, recipient_id, category_id, is_active\)\s*VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, true\)/,
    );
    // [date, signed amount, currency, memo, account_id, recipient_id,
    //  category_id] — external deposits stay uncategorized (transfers).
    expect(params).toEqual(["2026-01-05", 1000, "EUR", "wire", 7, 42, null]);
  });

  // ── D6 (ADR-095 addendum): an instrument-less dividend/interest/fee/tax row
  // reaches commit with route='cash' AND its canonical type — the sign comes
  // from the type (type_raw may be a broker synonym the classifier's kind sets
  // don't know) and the category from the kind map. ──
  it("D6 cash row: fee lands NEGATIVE with the INVESTMENTS:FEES category resolved via createOrGet", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: "fee",
        type_raw: "Custody Fee",
        investment_id: null,
        amount: 2.5,
        note: null,
        tx_hash: "hf",
      }),
    ];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, errors: 0 });
    expect(portfolioTransactionRepository.create).not.toHaveBeenCalled();
    expect(categoryRepository.createOrGet).toHaveBeenCalledWith({
      general: "INVESTMENTS",
      detail: "FEES",
    });
    const [, params] = query.mock.calls.find(([s]) =>
      /INSERT INTO transactions/.test(s),
    );
    // Signed by KIND (fee debits the sleeve) even though type_raw is a synonym
    // classifyBrokerageRow alone would send to review (defaulting to +1).
    expect(params).toEqual([
      "2026-01-05",
      -2.5,
      "EUR",
      "CUSTODY FEE",
      7,
      42,
      314,
    ]);
  });

  it("D6 cash row: dividend lands POSITIVE with INCOME:DIVIDENDS", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: "dividend",
        type_raw: "dividend",
        investment_id: null,
        amount: 12.34,
        note: null,
        tx_hash: "hd",
      }),
    ];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, errors: 0 });
    expect(categoryRepository.createOrGet).toHaveBeenCalledWith({
      general: "INCOME",
      detail: "DIVIDENDS",
    });
    const [, params] = query.mock.calls.find(([s]) =>
      /INSERT INTO transactions/.test(s),
    );
    expect(params).toEqual([
      "2026-01-05",
      12.34,
      "EUR",
      "DIVIDEND",
      7,
      42,
      314,
    ]);
  });

  it("D6 cash row: a soft-deleted category is NOT stamped — the row commits uncategorized", async () => {
    // createOrGet's ON CONFLICT DO NOTHING returns the user's soft-deleted row
    // as-is and nothing reactivates it, so auto-categorization must skip it
    // rather than file fresh ledger rows under a category no picker shows.
    isBrokerage = true;
    batchAccountId = 7;
    categoryRepository.createOrGet.mockResolvedValue({
      category: { id: 314, is_active: false },
      created: false,
    });
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: "dividend",
        type_raw: "dividend",
        investment_id: null,
        amount: 12.34,
        note: null,
        tx_hash: "hd",
      }),
    ];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1, errors: 0 });
    const [, params] = query.mock.calls.find(([s]) =>
      /INSERT INTO transactions/.test(s),
    );
    expect(params).toEqual([
      "2026-01-05",
      12.34,
      "EUR",
      "DIVIDEND",
      7,
      42,
      null,
    ]);
  });

  it("resolves the cash recipient from the sleeve account institution, trimmed, via createOrGet", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    accountInstitution = "  DeGiro  ";
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "deposit",
        investment_id: null,
        amount: 1000,
      }),
    ];
    await commitBatch({ batchId: 5 });
    // createOrGet uppercases + writes normalized_name itself; commit's job is to
    // hand it the trimmed institution so identity can't fork on whitespace.
    expect(recipientRepository.createOrGet).toHaveBeenCalledWith({
      name: "DeGiro",
    });
    expect(recipientRepository.getOrCreateSystemId).not.toHaveBeenCalled();
  });

  it("falls back to the account NAME when the institution is blank", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    accountInstitution = "   ";
    accountName = "IBKR SLEEVE";
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "deposit",
        investment_id: null,
        amount: 1000,
      }),
    ];
    await commitBatch({ batchId: 5 });
    expect(recipientRepository.createOrGet).toHaveBeenCalledWith({
      name: "IBKR SLEEVE",
    });
  });

  it("falls back to the shared SYSTEM recipient when the account has no usable label", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    accountInstitution = null;
    accountName = "   ";
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "deposit",
        investment_id: null,
        amount: 1000,
      }),
    ];
    await commitBatch({ batchId: 5 });
    expect(recipientRepository.createOrGet).not.toHaveBeenCalled();
    expect(recipientRepository.getOrCreateSystemId).toHaveBeenCalledTimes(1);
    const [, params] = query.mock.calls.find(([s]) =>
      /INSERT INTO transactions/.test(s),
    );
    expect(params[5]).toBe(99); // the SYSTEM id, not null
  });

  it("hoists recipient resolution to once per commit, not once per cash row", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "deposit",
        investment_id: null,
        amount: 1000,
        tx_hash: "c1",
      }),
      row({
        id: 10,
        route: "cash",
        type: null,
        type_raw: "withdrawal",
        investment_id: null,
        amount: 250,
        tx_hash: "c2",
      }),
    ];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 2 });
    expect(recipientRepository.createOrGet).toHaveBeenCalledTimes(1);
    const cashInserts = query.mock.calls.filter(([s]) =>
      /INSERT INTO transactions/.test(s),
    );
    expect(cashInserts).toHaveLength(2);
    for (const [, params] of cashInserts) expect(params[5]).toBe(42);
  });

  it("does not touch the recipient repository when the batch has no cash rows", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [row({ route: "portfolio", type: "buy", type_raw: "buy" })];
    await commitBatch({ batchId: 5 });
    expect(recipientRepository.createOrGet).not.toHaveBeenCalled();
    expect(recipientRepository.getOrCreateSystemId).not.toHaveBeenCalled();
  });

  it("brokerage withdrawal: debits the sleeve (negative amount) even though staging is absolute", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "withdrawal",
        investment_id: null,
        amount: 500,
      }),
    ];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 1 });
    const cashInsert = query.mock.calls.find(([s]) =>
      /INSERT INTO transactions/.test(s),
    );
    expect(cashInsert[1][1]).toBe(-500); // amount param — was +500 (credited as a deposit)
  });

  it("cash dedup matches across the sign fix: signed value OR legacy positive magnitude", async () => {
    // A withdrawal committed BEFORE the cash-sign fix is stored positive (+500);
    // the post-fix insert stores the signed −500. The dedup must recognize both
    // as the same row so re-importing an already-imported statement is a no-op.
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "withdrawal",
        investment_id: null,
        amount: 500,
      }),
    ];
    await commitBatch({ batchId: 5 });

    const dedupCall = query.mock.calls.find(([s]) =>
      /AS n FROM transactions/.test(s),
    );
    // Predicate accepts either the post-fix signed value or the legacy magnitude.
    expect(dedupCall[0]).toMatch(/amount = \$3 OR amount = \$4/);
    // params: [accountId, tx_date, signed(-500), magnitude(500), currency, memo]
    expect(dedupCall[1][2]).toBe(-500); // signed (post-fix) branch
    expect(dedupCall[1][3]).toBe(500); // legacy positive (pre-fix) branch
    expect(dedupCall[1][4]).toBe("EUR");
    expect(dedupCall[1][5]).toBe("WITHDRAWAL"); // memo carries the kind/direction
  });

  it("D6 cash dedup matches the SIGNED amount only — no legacy magnitude leg", async () => {
    // The magnitude leg exists for pre-sign-fix deposit/withdrawal legacy rows
    // only. D6 kinds have no legacy: with the leg, a new −10 fee would dedup
    // against an unrelated +10 row sharing date and memo and silently vanish.
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: "fee",
        type_raw: "fee",
        investment_id: null,
        amount: 10,
        tx_hash: "hf",
      }),
    ];
    await commitBatch({ batchId: 5 });

    const dedupCall = query.mock.calls.find(([s]) =>
      /AS n FROM transactions/.test(s),
    );
    expect(dedupCall[0]).toMatch(/amount = \$3/);
    expect(dedupCall[0]).not.toMatch(/amount = \$4|OR amount/); // no magnitude branch at all
    // params: [accountId, tx_date, signed(-10), currency, memo] — magnitude never sent.
    expect(dedupCall[1]).toEqual([7, "2026-01-05", -10, "EUR", "FEE"]);
  });

  it("cash dedup does not conflate opposite directions: a deposit only matches positive amounts", async () => {
    // A +500 deposit's signed value equals its magnitude, so both branches are
    // +500 — it can never dedup against a −500 withdrawal on the same day.
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "deposit",
        investment_id: null,
        amount: 500,
      }),
    ];
    await commitBatch({ batchId: 5 });

    const dedupCall = query.mock.calls.find(([s]) =>
      /AS n FROM transactions/.test(s),
    );
    expect(dedupCall[1][2]).toBe(500); // signed
    expect(dedupCall[1][3]).toBe(500); // magnitude — same, so no negative branch
    expect(dedupCall[1][4]).toBe("EUR");
    expect(dedupCall[1][5]).toBe("DEPOSIT");
  });

  it("brokerage cash row: dedups against an existing cash transaction", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    cashDuplicate = true;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "deposit",
        investment_id: null,
        amount: 1000,
      }),
    ];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 0, duplicates: 1 });
  });

  it("preserves two identical same-hash cash rows on their first import", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: "fee",
        type_raw: "fee",
        investment_id: null,
        amount: 10,
        tx_hash: "same",
      }),
      row({
        id: 10,
        route: "cash",
        type: "fee",
        type_raw: "fee",
        investment_id: null,
        amount: 10,
        tx_hash: "same",
      }),
    ];

    const res = await commitBatch({ batchId: 5 });

    expect(res).toMatchObject({ imported: 2, duplicates: 0, errors: 0 });
    expect(
      query.mock.calls.filter(([sql]) => /INSERT INTO transactions/.test(sql)),
    ).toHaveLength(2);
  });

  it("pairs repeated cash rows one-for-one with existing rows", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    cashDuplicate = 1;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: "fee",
        type_raw: "fee",
        investment_id: null,
        amount: 10,
      }),
      row({
        id: 10,
        route: "cash",
        type: "fee",
        type_raw: "fee",
        investment_id: null,
        amount: 10,
      }),
    ];

    const res = await commitBatch({ batchId: 5 });

    expect(res).toMatchObject({ imported: 1, duplicates: 1, errors: 0 });
  });

  it("makes a repeated cash-row reimport a complete no-op", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    cashDuplicate = 2;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: "fee",
        type_raw: "fee",
        investment_id: null,
        amount: 10,
      }),
      row({
        id: 10,
        route: "cash",
        type: "fee",
        type_raw: "fee",
        investment_id: null,
        amount: 10,
      }),
    ];

    const res = await commitBatch({ batchId: 5 });

    expect(res).toMatchObject({ imported: 0, duplicates: 2, errors: 0 });
  });

  it("resumes repeated cash rows after an earlier chunk was committed", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    cashDuplicate = 1;
    matchedRows = [
      row({
        id: 9,
        status: "committed",
        route: "cash",
        type: "fee",
        type_raw: "fee",
        investment_id: null,
        amount: 10,
      }),
      row({
        id: 10,
        status: "matched",
        route: "cash",
        type: "fee",
        type_raw: "fee",
        investment_id: null,
        amount: 10,
      }),
    ];

    const res = await commitBatch({ batchId: 5 });

    expect(res).toMatchObject({ imported: 1, duplicates: 0, errors: 0 });
    expect(
      query.mock.calls.filter(([sql]) => /INSERT INTO transactions/.test(sql)),
    ).toHaveLength(1);
  });

  it("includes cash currency in the dedup identity", async () => {
    isBrokerage = true;
    batchAccountId = 7;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: "fee",
        type_raw: "fee",
        investment_id: null,
        amount: 10,
        currency: "USD",
      }),
    ];

    await commitBatch({ batchId: 5 });

    const dedupCall = query.mock.calls.find(([sql]) =>
      /AS n FROM transactions/.test(sql),
    );
    expect(dedupCall[0]).toContain("COALESCE(currency, 'EUR')");
    expect(dedupCall[1]).toContain("USD");
  });

  it("brokerage cash row with no batch account is an error", async () => {
    isBrokerage = true;
    batchAccountId = null;
    matchedRows = [
      row({
        id: 9,
        route: "cash",
        type: null,
        type_raw: "deposit",
        investment_id: null,
        amount: 1000,
      }),
    ];
    const res = await commitBatch({ batchId: 5 });
    expect(res).toMatchObject({ imported: 0, errors: 1 });
    expect(marked[0]).toMatchObject({
      status: "error",
      message: expect.stringMatching(/account/),
    });
  });
});
